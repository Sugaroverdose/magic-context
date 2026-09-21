//! Adversarial gate over the host-runner slice (A1) merged with the
//! single-store marker slice (B0).
//!
//! Every test here drives the real dispatcher, the real store and the real
//! restart path, and each one exists to settle one claim the two deliveries
//! make. Where a test records behaviour the deliveries did not claim, its name
//! says what it observed rather than what it approves of.

use super::*;
use rusqlite::Connection;

const GATE_SYSTEM_PROMPT: &str = "gate-system-prompt";
const GATE_AWAIT_BUDGET_MS: i64 = 660_000;

/// Open the store file a test handler is using, read-only, so a test can see
/// the claim queue rows the public API does not expose.
fn queue_rows(
    data_home: &std::path::Path,
) -> Vec<(String, String, String, Option<String>, String)> {
    let path = sqlite_store_path(data_home.to_str().unwrap(), DEFAULT_MODULE_ID);
    let conn = Connection::open(&path).unwrap();
    let mut statement = conn
        .prepare(
            "SELECT run_id, session_id, phase, coordinator_token, chunk_fingerprint
               FROM mc_historian_pending_run ORDER BY run_id",
        )
        .unwrap();
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    rows
}

/// Park `session_id` on a firing and queue its run for a claimant, exactly as
/// the host lane does between assembling the chunk and waiting for a report.
fn queue_run_for(
    store: &McStore,
    session_id: &str,
    run_id: &str,
    project_path: &str,
    user_prompt: &str,
    now_ms: i64,
) {
    let loaded = store.load(session_id).unwrap();
    let mut meta = loaded.meta.clone();
    meta.historian = HistorianDurableState {
        state: HistorianPhase::Firing,
        firing_seq: 1,
        chunk_range: Some(HistorianChunkRange {
            from_ordinal: 1,
            to_ordinal: 3,
        }),
        chunk_fingerprint: format!("fp-{session_id}"),
        fired_at_ms: Some(now_ms),
        ..HistorianDurableState::default()
    };
    store
        .commit(session_id, loaded.row_version, &loaded.core, &meta)
        .unwrap();
    store
        .publish_pending_historian_run(&mc_store::NewHistorianPendingRun {
            run_id: run_id.to_string(),
            session_id: session_id.to_string(),
            project_path: project_path.to_string(),
            firing_seq: 1,
            chunk_fingerprint: format!("fp-{session_id}"),
            system_prompt: GATE_SYSTEM_PROMPT.to_string(),
            user_prompt: user_prompt.to_string(),
            model_chain: vec!["test/first".to_string()],
            await_budget_ms: GATE_AWAIT_BUDGET_MS,
            now_ms,
        })
        .unwrap();
}

/// FINDING: the claim lane is reachable from a channel that never bound a
/// session, and one `historian.pending` with no `session_id` hands every run in
/// the store to whoever asked — including runs belonging to a different project
/// than the caller's. `historian.claim` then returns that run's prompt, which is
/// the folded conversation transcript.
///
/// Every other management op on this dispatcher that reads session state goes
/// through `management_binding`, which refuses an unbound channel
/// (`route_unbound`) and a session that is not the channel's
/// (`session_mismatch`). The four claim ops do not, by design: a claimant polls
/// without knowing which session produced a run. The cost of that design is what
/// this test records.
#[tokio::test(flavor = "current_thread")]
async fn gate_pending_hands_an_unbound_caller_another_projects_run_and_prompt() {
    let (handler, store, dir, project) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    let now = now_ms();
    queue_run_for(
        &store,
        "ses",
        "run-own-project",
        &project.to_string_lossy(),
        "transcript of the bound project",
        now,
    );
    queue_run_for(
        &store,
        "other-project-session",
        "run-other-project",
        "/somewhere/else/entirely",
        "transcript of a project this channel never bound",
        now,
    );

    // Channel 9 never bound anything. A management op that reads session state
    // refuses it; the claim lane answers it.
    let (unbound_code, _) = error_frame(
        handler
            .dispatch_value(
                9,
                json!({ "method": "session.status", "v": 1, "session_id": "ses" }),
            )
            .await,
    );
    assert_eq!(
        unbound_code, "route_unbound",
        "the comparison surface has to actually refuse an unbound channel"
    );

    let listed = call_dispatch_request_on_channel(
        &handler,
        9,
        json!({ "method": "historian.pending", "v": 1 }),
    )
    .await;
    let run_ids: Vec<&str> = listed["runs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|run| run["run_id"].as_str().unwrap())
        .collect();
    assert_eq!(
        run_ids,
        vec!["run-other-project", "run-own-project"],
        "pending lists every session the store serves, across projects: {listed}"
    );

    let claimed = call_dispatch_request_on_channel(
        &handler,
        9,
        json!({
            "method": "historian.claim",
            "v": 1,
            "run_id": "run-other-project",
            "claimant_instance_id": "some-other-install",
        }),
    )
    .await;
    assert_eq!(claimed["ok"], json!(true), "{claimed}");
    assert_eq!(
        claimed["prompt"]["user"],
        json!("transcript of a project this channel never bound"),
        "the claim hands the caller the other project's transcript"
    );
    drop(dir);
}

/// FINDING: `v` is documented on all four claim requests and pinned in the wire
/// fixture, but no handler reads it. A request with no `v`, or with a version
/// this module has never heard of, is served as if it were `v: 1`.
///
/// The management ops next to these refuse a missing or wrong `v` with
/// `bad_request`, so the difference is a property of the claim lane, not of the
/// envelope.
#[tokio::test(flavor = "current_thread")]
async fn gate_the_claim_lane_serves_requests_whose_version_it_never_read() {
    let (handler, store, dir, project) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    queue_run_for(
        &store,
        "ses",
        "run-versionless",
        &project.to_string_lossy(),
        "transcript",
        now_ms(),
    );

    let (bad_code, _) = error_frame(
        handler
            .dispatch_value(
                7,
                json!({ "method": "session.status", "session_id": "ses" }),
            )
            .await,
    );
    assert_eq!(
        bad_code, "bad_request",
        "the comparison surface has to actually require a version"
    );

    for request in [
        json!({ "method": "historian.pending" }),
        json!({ "method": "historian.pending", "v": 99 }),
        json!({ "method": "historian.pending", "v": "not-a-number" }),
    ] {
        let served = call_dispatch_request(&handler, request.clone()).await;
        assert_eq!(served["ok"], json!(true), "{request} -> {served}");
        assert_eq!(
            served["runs"][0]["run_id"],
            json!("run-versionless"),
            "{request} -> {served}"
        );
    }
    drop(dir);
}

/// Two claimants reaching for one run: exactly one gets a token, and the loser
/// is told which kind of loss it was.
#[tokio::test(flavor = "current_thread")]
async fn gate_two_claimants_on_one_run_leave_exactly_one_live_token() {
    let (handler, store, dir, project) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    queue_run_for(
        &store,
        "ses",
        "run-contested",
        &project.to_string_lossy(),
        "transcript",
        now_ms(),
    );

    let first = call_dispatch_request(
        &handler,
        json!({
            "method": "historian.claim", "v": 1,
            "run_id": "run-contested", "claimant_instance_id": "install-one",
        }),
    )
    .await;
    let second = call_dispatch_request(
        &handler,
        json!({
            "method": "historian.claim", "v": 1,
            "run_id": "run-contested", "claimant_instance_id": "install-two",
        }),
    )
    .await;

    assert_eq!(first["ok"], json!(true), "{first}");
    assert_eq!(first["attempt"], json!(1));
    assert_eq!(
        second,
        json!({ "ok": false, "refusal": "already_claimed" }),
        "the second claimant is told the run is held, not that it is gone"
    );

    let state = store.historian_state("ses").unwrap();
    assert_eq!(state.state, HistorianPhase::AwaitingProducer);
    assert_eq!(state.producer_attempt, 1);
    assert_eq!(
        state.coordinator_token.as_deref(),
        first["token"].as_str(),
        "the session's own state names the one claim that won"
    );
    let rows = queue_rows(&dir.path().join("data"));
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].2, "claimed");
    assert_eq!(rows[0].3.as_deref(), first["token"].as_str());
    drop(dir);
}

/// A claimant that blew its lease and one that arrives after it: whichever
/// request reaches the store first decides, and the other is refused with the
/// code that says why.
///
/// Both orders are driven. The first order records behaviour neither delivery
/// document states: a heartbeat arriving after the lease already lapsed is
/// accepted and revives the claim, so the replacement is then refused
/// `already_claimed`.
#[tokio::test(flavor = "current_thread")]
async fn gate_a_late_heartbeat_and_a_post_expiry_claim_never_both_win() {
    for heartbeat_first in [true, false] {
        let (handler, store, dir, project) =
            handler_with_store(Arc::new(ProducerState::default()), default_test_config());
        // Queued far enough back that the lease has lapsed while the run's own
        // deadline has not: those are different clocks, which is what leaves a
        // re-claim worth offering.
        let queued_at_ms = now_ms() - mc_store::HISTORIAN_LEASE_CEILING_MS - 1;
        queue_run_for(
            &store,
            "ses",
            "run-expiring",
            &project.to_string_lossy(),
            "transcript",
            queued_at_ms,
        );
        let mc_store::HistorianClaimOutcome::Claimed(held) = store
            .claim_historian_run("run-expiring", "install-one", queued_at_ms)
            .unwrap()
        else {
            panic!("the first claimant must win");
        };

        let beat = json!({
            "method": "historian.heartbeat", "v": 1,
            "run_id": "run-expiring", "token": held.token,
        });
        let claim = json!({
            "method": "historian.claim", "v": 1,
            "run_id": "run-expiring", "claimant_instance_id": "install-two",
        });

        let (beat_answer, claim_answer) = if heartbeat_first {
            let b = call_dispatch_request(&handler, beat).await;
            let c = call_dispatch_request(&handler, claim).await;
            (b, c)
        } else {
            let c = call_dispatch_request(&handler, claim).await;
            let b = call_dispatch_request(&handler, beat).await;
            (b, c)
        };

        if heartbeat_first {
            assert_eq!(
                beat_answer["ok"],
                json!(true),
                "an expired lease is revived by a beat that arrives before a replacement: {beat_answer}"
            );
            assert_eq!(
                claim_answer,
                json!({ "ok": false, "refusal": "already_claimed" }),
                "{claim_answer}"
            );
            let state = store.historian_state("ses").unwrap();
            assert_eq!(state.producer_attempt, 1);
            assert_eq!(
                state.coordinator_token.as_deref(),
                Some(held.token.as_str())
            );
        } else {
            assert_eq!(claim_answer["ok"], json!(true), "{claim_answer}");
            assert_eq!(claim_answer["attempt"], json!(2));
            assert_eq!(
                beat_answer,
                json!({
                    "ok": false,
                    "refusal": "superseded_token",
                }),
                "the replaced claimant's beat cannot extend a claim it no longer holds"
            );
            let state = store.historian_state("ses").unwrap();
            assert_eq!(state.producer_attempt, 2);
            assert_ne!(
                state.coordinator_token.as_deref(),
                Some(held.token.as_str())
            );
        }

        // Whichever order ran, the durable state names exactly one live claim.
        let rows = queue_rows(&dir.path().join("data"));
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].2, "claimed");
        assert_eq!(
            rows[0].3,
            store.historian_state("ses").unwrap().coordinator_token,
            "the queue row and the session state agree on who holds the run"
        );
        drop(dir);
    }
}

/// Every refusal `historian.complete` can give, driven through the dispatcher:
/// a superseded token, a run that was never queued, and a run nobody holds.
#[tokio::test(flavor = "current_thread")]
async fn gate_complete_refuses_a_superseded_an_unknown_and_an_unclaimed_run() {
    let (handler, store, dir, project) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    let queued_at_ms = now_ms() - mc_store::HISTORIAN_LEASE_CEILING_MS - 1;
    queue_run_for(
        &store,
        "ses",
        "run-reported",
        &project.to_string_lossy(),
        "transcript",
        queued_at_ms,
    );

    let unknown = call_dispatch_request(
        &handler,
        json!({
            "method": "historian.complete", "v": 1,
            "run_id": "run-that-was-never-queued", "token": "0".repeat(32),
            "output": { "text": "<compartments/>" },
        }),
    )
    .await;
    assert_eq!(unknown, json!({ "ok": false, "refusal": "unknown_run" }));

    let unclaimed = call_dispatch_request(
        &handler,
        json!({
            "method": "historian.complete", "v": 1,
            "run_id": "run-reported", "token": "0".repeat(32),
            "output": { "text": "<compartments/>" },
        }),
    )
    .await;
    assert_eq!(
        unclaimed,
        json!({ "ok": false, "refusal": "not_claimed" }),
        "nobody holds the run, so no token can be the current one"
    );

    let mc_store::HistorianClaimOutcome::Claimed(first) = store
        .claim_historian_run("run-reported", "install-one", queued_at_ms)
        .unwrap()
    else {
        panic!("the first claimant must win");
    };
    let second = call_dispatch_request(
        &handler,
        json!({
            "method": "historian.claim", "v": 1,
            "run_id": "run-reported", "claimant_instance_id": "install-two",
        }),
    )
    .await;
    assert_eq!(second["attempt"], json!(2), "{second}");

    // A waiter exists, so the only thing that can refuse this report is the
    // token check — which runs before the body is parsed.
    let _registration = handler.host_runs.register("run-reported");
    let superseded = call_dispatch_request(
        &handler,
        json!({
            "method": "historian.complete", "v": 1,
            "run_id": "run-reported", "token": first.token,
            "output": { "text": "not valid compartment xml at all" },
        }),
    )
    .await;
    assert_eq!(
        superseded,
        json!({ "ok": false, "refusal": "superseded_token" }),
        "a prior attempt's report is refused in every phase, before its body is read"
    );
    drop(dir);
}

/// FINDING: a heartbeat sent after the run's OWN deadline has passed is answered
/// `ok: true`, carrying a `claim_deadline_ms` that is already in the past.
///
/// The same run is by then unclaimable and unlistable — `historian.pending` and
/// `historian.claim` both refuse it on the run deadline — so the heartbeat is
/// the one op in the lane that tells a claimant to keep going after the module
/// has stopped waiting. A claimant that treats `ok` as "keep working" keeps
/// spending on a completion that can no longer be delivered.
#[tokio::test(flavor = "current_thread")]
async fn gate_a_heartbeat_after_the_runs_own_deadline_is_answered_ok() {
    let (handler, store, dir, project) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    let queued_at_ms = now_ms() - GATE_AWAIT_BUDGET_MS - 1;
    queue_run_for(
        &store,
        "ses",
        "run-past-deadline",
        &project.to_string_lossy(),
        "transcript",
        queued_at_ms,
    );
    // Claimed while the run was still live, so there is a current token to beat with.
    let mc_store::HistorianClaimOutcome::Claimed(held) = store
        .claim_historian_run("run-past-deadline", "install-one", queued_at_ms)
        .unwrap()
    else {
        panic!("the claim has to be taken before the deadline to set this up");
    };

    let listed =
        call_dispatch_request(&handler, json!({ "method": "historian.pending", "v": 1 })).await;
    assert_eq!(
        listed,
        json!({ "ok": true, "runs": [] }),
        "a run past its own deadline is never offered again"
    );
    let reclaim = call_dispatch_request(
        &handler,
        json!({
            "method": "historian.claim", "v": 1,
            "run_id": "run-past-deadline", "claimant_instance_id": "install-two",
        }),
    )
    .await;
    assert_eq!(reclaim, json!({ "ok": false, "refusal": "not_pending" }));

    let beat = call_dispatch_request(
        &handler,
        json!({
            "method": "historian.heartbeat", "v": 1,
            "run_id": "run-past-deadline", "token": held.token,
        }),
    )
    .await;
    assert_eq!(
        beat["ok"],
        json!(true),
        "recorded as observed, not as approved: {beat}"
    );
    let granted = beat["claim_deadline_ms"].as_i64().unwrap();
    assert!(
        granted < now_ms(),
        "the lease it grants has already expired: {beat}"
    );
    drop(dir);
}

/// Restart with a run parked for a claimant: A1 says the run is released. It is,
/// and nothing double-publishes — but the queue row it was advertised through
/// stays behind, and nothing ever deletes it.
///
/// FINDING: after the release the session is `Idle` with no producer run, while
/// `mc_historian_pending_run` still holds a `pending` row for the released run.
/// `historian.pending` keeps advertising it until its own deadline passes, and a
/// claimant that takes the bait is refused `not_pending` after paying for the
/// round trip. Nothing on the historian's own paths removes the row: not the
/// restart handler that released the run, and not the expiry sweep, which only
/// looks at claimed rows. Deleting the session does remove it, so the row lives
/// as long as the session does — which for a folding session is the whole point
/// of the session.
#[tokio::test(flavor = "current_thread")]
async fn gate_restart_releases_a_parked_run_but_leaves_its_queue_row_behind() {
    let (handler, store, dir, project) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    let data_home = dir.path().join("data");
    let now = now_ms();
    queue_run_for(
        &store,
        "ses",
        "run-parked",
        &project.to_string_lossy(),
        "transcript",
        now,
    );

    let parked = store.historian_state("ses").unwrap();
    assert_eq!(parked.state, HistorianPhase::Reclaiming);
    assert_eq!(parked.chunk_fingerprint, "fp-ses");
    assert_eq!(parked.firing_seq, 1);

    // The boot path, called exactly as the transform recovery arm calls it.
    let action = crate::historian::handle_restart_load(&store, "ses", now + 60_000).unwrap();
    assert!(
        matches!(
            action,
            crate::historian::RestartAction::AbandonedAndRefireEligible { firing_seq: 1 }
        ),
        "a parked run is released on boot: {action:?}"
    );

    let released = store.historian_state("ses").unwrap();
    assert_eq!(released.state, HistorianPhase::Idle);
    assert_eq!(released.producer_run_id, None);
    assert_eq!(released.coordinator_token, None);
    assert_eq!(
        released.firing_seq, 1,
        "the failed sequence is kept so the next fire stays monotonic"
    );
    assert_eq!(
        released.chunk_fingerprint, "",
        "the released run's chunk identity is dropped from the session with it, so the \
         next trigger assembles a fresh chunk rather than publishing against a stale one"
    );
    assert_eq!(
        store.load_compartments("ses").unwrap().len(),
        0,
        "releasing a parked run publishes nothing"
    );

    // The row the run was advertised through is still there.
    let rows = queue_rows(&data_home);
    assert_eq!(
        rows,
        vec![(
            "run-parked".to_string(),
            "ses".to_string(),
            "pending".to_string(),
            None,
            // The fingerprint is not lost from the store: the released run's copy of
            // it survives in the orphan queue row, which is what a later
            // re-publication on boot would need and what nothing reads today.
            "fp-ses".to_string()
        )],
        "the queue row outlives the run it belonged to"
    );
    let still_listed =
        call_dispatch_request(&handler, json!({ "method": "historian.pending", "v": 1 })).await;
    assert_eq!(
        still_listed["runs"][0]["run_id"],
        json!("run-parked"),
        "a released run is still advertised to claimants: {still_listed}"
    );
    let wasted = call_dispatch_request(
        &handler,
        json!({
            "method": "historian.claim", "v": 1,
            "run_id": "run-parked", "claimant_instance_id": "install-one",
        }),
    )
    .await;
    assert_eq!(
        wasted,
        json!({ "ok": false, "refusal": "not_pending" }),
        "taking the bait is refused, so nothing double-publishes"
    );

    // The sweep does not reclaim it: it only looks at rows a claimant holds.
    store.expire_historian_claims(now + 60_000).unwrap();
    assert_eq!(
        queue_rows(&data_home).len(),
        1,
        "the sweep only touches claimed rows, so a released run's row survives it"
    );
    // Deleting the session does remove it, which bounds the leak at the session's
    // own lifetime rather than at the run's.
    let deleted = call_dispatch_request(
        &handler,
        json!({ "method": "session.delete", "v": 1, "session_id": "ses" }),
    )
    .await;
    assert_eq!(deleted["ok"], json!(true), "{deleted}");
    assert_eq!(
        queue_rows(&data_home).len(),
        0,
        "deleting the session is the only path that reclaims the row"
    );
    drop(dir);
}

/// B0 asserts the single-store refusal on `store_refusal()` because an unbound
/// channel is refused before the store is consulted. Bind the channel and
/// `session.status` reaches the store refusal for real, which is the seam the
/// gate was asked to check.
#[tokio::test]
async fn gate_session_status_and_the_claim_lane_name_the_single_store_refusal() {
    let dir = tempfile::tempdir().unwrap();
    let data_home = dir.path().join("data");
    std::fs::create_dir_all(&data_home).unwrap();
    let descriptor = dev_descriptor_at(data_home.to_str().unwrap());
    let migrated = McStore::open(&descriptor).unwrap();
    migrated
        .set_single_store_marker_for_test(1_758_000_000_000, "a1b2c3d4")
        .unwrap();
    drop(migrated);

    let handler = McHandler::new();
    let project = dir.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    handler.bind_route(7, binding(project.to_str().unwrap(), "ses"));
    handler.begin_store_open(descriptor, DescriptorOrigin::DevFallback);
    tokio::time::timeout(Duration::from_secs(5), async {
        while handler.store_open.failure_snapshot().is_none() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("an open that cannot succeed must record its reason");

    for request in [
        json!({ "method": "session.status", "v": 1, "session_id": "ses" }),
        json!({ "method": "historian.pending", "v": 1 }),
        json!({ "method": "historian.claim", "v": 1, "run_id": "r", "claimant_instance_id": "i" }),
    ] {
        let (code, message) = error_frame(handler.dispatch_value(7, request.clone()).await);
        assert_eq!(code, "store_open_failed", "{request}");
        assert!(
            message.contains(&format!("reason_code={SINGLE_STORE_MARKER_REFUSAL_REASON}")),
            "{request} -> {message}"
        );
        assert!(
            message.contains("ck-mc a1b2c3d4"),
            "the refusal has to say which build to run: {message}"
        );
        assert!(
            message.contains("terminal"),
            "a store this binary cannot read is not something a retry fixes: {message}"
        );
    }
}
