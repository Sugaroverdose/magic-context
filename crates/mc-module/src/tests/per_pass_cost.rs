//! Release-only, copy-only profile of persisted large-session state.
//!
//! The databases do not contain the host's full native request arrays. Rebuild
//! their shape from block identities and absolute ordinals, with scrubbed text
//! sized from tag sources. Keep the real frozen-unit/overlay state. This is a
//! scale experiment, not an exact replay of the private host's requests.

use super::*;
use crate::per_pass_profile;
use std::cell::Cell;
use std::marker::PhantomData;
use std::process::Command;
use std::rc::Rc;

thread_local! {
    static DIFFERENTIALS_DISABLED: Cell<bool> = const { Cell::new(false) };
}

pub(super) fn differentials_disabled() -> bool {
    DIFFERENTIALS_DISABLED.get()
}

// A thread-bound guard covers normalization, warmups and measured passes on the
// harness's current-thread runtime. Other tests keep their full references, even
// when they run concurrently, and unwinding restores the prior setting.
struct DifferentialOverride {
    previous: bool,
    _thread_bound: PhantomData<Rc<()>>,
}

impl DifferentialOverride {
    fn new(references: bool) -> Self {
        Self {
            previous: DIFFERENTIALS_DISABLED.replace(!references),
            _thread_bound: PhantomData,
        }
    }
}

impl Drop for DifferentialOverride {
    fn drop(&mut self) {
        DIFFERENTIALS_DISABLED.set(self.previous);
    }
}

fn references_enabled(value: Option<&str>) -> bool {
    match value {
        None | Some("on") => true,
        Some("off") => false,
        Some(other) => panic!("MC_PER_PASS_REFERENCES must be on or off, got {other:?}"),
    }
}

#[test]
fn per_pass_differential_override_is_scoped_and_thread_local() {
    let predicates = || {
        (
            crate::transform::prefix_projection_differential_enabled(),
            native_attachment_differential_enabled(),
        )
    };
    assert_eq!(predicates(), (true, true));
    {
        let _off = DifferentialOverride::new(false);
        assert_eq!(predicates(), (false, false));
        // The test default remains on on a separate worker thread.
        assert_eq!(std::thread::spawn(predicates).join().unwrap(), (true, true));
        {
            let _on = DifferentialOverride::new(true);
            assert_eq!(predicates(), (true, true));
        }
        assert_eq!(predicates(), (false, false));
    }
    assert_eq!(predicates(), (true, true));
    let unwind = std::panic::catch_unwind(|| {
        let _off = DifferentialOverride::new(false);
        assert_eq!(predicates(), (false, false));
        panic!("exercise scope cleanup");
    });
    assert!(unwind.is_err());
    assert_eq!(predicates(), (true, true));
}

#[test]
fn per_pass_reference_mode_defaults_on_and_rejects_unknown_values() {
    assert!(references_enabled(None));
    assert!(references_enabled(Some("on")));
    assert!(!references_enabled(Some("off")));
    assert!(std::panic::catch_unwind(|| references_enabled(Some("0"))).is_err());
}

fn immutable(path: &Path) -> rusqlite::Connection {
    rusqlite::Connection::open_with_flags(
        format!("file:{}?immutable=1", path.display()),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .unwrap()
}

fn copy_backup(source: &Path, target: &Path) {
    // APFS clones avoid re-copying gigabytes for each session. Other platforms
    // use a regular copy; neither branch ever copies or opens the live files.
    #[cfg(target_os = "macos")]
    assert!(Command::new("cp")
        .args(["-c"])
        .arg(source)
        .arg(target)
        .status()
        .unwrap()
        .success());
    #[cfg(not(target_os = "macos"))]
    std::fs::copy(source, target).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(target, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
}

fn shape(store: &McStore, backups: &Path, session: &str, limit: usize) -> Vec<CkIngressMessage> {
    let conn = immutable(&backups.join("context.db"));
    conn.execute(
        "ATTACH ?1 AS cache",
        [format!(
            "file:{}?immutable=1",
            backups.join("store.db").display()
        )],
    )
    .unwrap();
    let rows = conn
        .prepare(
            "SELECT b.mid, b.identities, s.role, s.message_ordinal
             FROM cache.mc_block_identities b JOIN message_history_source s
               ON b.session_id=s.session_id AND b.mid=s.message_id
             WHERE b.session_id=?1 ORDER BY s.message_ordinal DESC LIMIT ?2",
        )
        .unwrap()
        .query_map(rusqlite::params![session, limit], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, u64>(3)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(
        !rows.is_empty(),
        "session must have persisted identities and host ordinals"
    );
    let lengths: HashMap<_, _> = store
        .load_tags_for_session(session)
        .unwrap()
        .into_iter()
        .map(|tag| (tag.block_id, tag.source_bytes.len()))
        .collect();
    let filler = |len: usize| {
        let mut text = "scrubbed ".repeat(len / 9 + 1);
        text.truncate(len.max(1));
        text
    };
    let mut messages = Vec::new();
    for (mid, identities, role, ordinal) in rows.into_iter().rev() {
        let kinds: Vec<Value> = serde_json::from_str(&identities).unwrap();
        let mut call = String::new();
        let mut blocks = kinds
            .iter()
            .enumerate()
            .map(|(index, identity)| {
                let len = lengths
                    .get(&format!("{mid}#{index}"))
                    .copied()
                    .unwrap_or(64);
                let kind = match identity["kind_tag"].as_str().unwrap_or("opaque") {
                    "text" => CkKind::Text { text: filler(len) },
                    "reasoning" => CkKind::Reasoning {
                        text: filler(64),
                        signature: None,
                    },
                    "redacted_reasoning" => CkKind::RedactedReasoning { data: filler(32) },
                    "tool_call" => {
                        call = format!("profile-{mid}-{index}");
                        CkKind::ToolCall {
                            id: call.clone(),
                            name: "read".into(),
                            input: json!({"filePath":"profile.txt"}),
                            provider_executed: false,
                        }
                    }
                    "tool_result" if !call.is_empty() => CkKind::ToolResult {
                        id: call.clone(),
                        tool_name: "read".into(),
                        output: CkToolOutput::bare(CkOutputKind::Text { text: filler(len) }),
                        provider_executed: false,
                    },
                    "media" => CkKind::Media(crate::ck_wire::MediaBlock {
                        kind: crate::ck_wire::MediaKind::Image,
                        media_type: "image/png".into(),
                        filename: None,
                        source: json!({"type":"data_base64","data":"aGVsbG8="}),
                    }),
                    "tool_result" => CkKind::Text { text: filler(len) },
                    _ => CkKind::Opaque(crate::ck_wire::OpaqueBlock {
                        source: json!({"type":"harness","harness":"opencode"}),
                        kind: "step-start".into(),
                        raw: json!({"type":"step-start"}),
                        arc: None,
                    }),
                };
                CkWireBlock::bare(kind)
            })
            .collect::<Vec<_>>();
        let answered: HashSet<_> = blocks
            .iter()
            .filter_map(|block| match &block.kind {
                CkKind::ToolResult { id, .. } => Some(id.clone()),
                _ => None,
            })
            .collect();
        for block in &mut blocks {
            if matches!(&block.kind, CkKind::ToolCall { id, .. } if !answered.contains(id)) {
                *block = CkWireBlock::bare(CkKind::Text {
                    text: "unanswered scrubbed call".into(),
                });
            }
        }
        let mut ck = CkWireMessage::from_parts(
            role,
            blocks,
            None,
            ProviderExtras::new(),
            HarnessMeta::default(),
        );
        ck.meta.harness_id = Some(mid.clone());
        messages.push(CkIngressMessage { mid, ordinal, ck });
    }
    // Change only this provisional assistant on repeated passes; historical
    // identities remain stable and the store still commits a changed suffix.
    let ordinal = messages.last().unwrap().ordinal + 1;
    let mut live = ck_with_role("profile-live", ordinal, "assistant", "profile live");
    live.ck.meta.harness_id = Some("profile-live".into());
    messages.push(live);
    messages
}

fn native(messages: &[CkIngressMessage], session: &str) -> Vec<Value> {
    messages
        .iter()
        .flat_map(|message| {
            codec::opencode::encode_opencode_with_session(
                std::slice::from_ref(&message.ck),
                &codec::DecodeSidecar::new("opencode"),
                Some(session),
                None,
            )
        })
        .collect()
}

fn output_bytes(response: &Value) -> Vec<u8> {
    // Timings, clocks, pass row versions and diagnostic metadata are not
    // provider input. Compare the complete CK and native arrays themselves.
    serde_json::to_vec(&json!({"ck":response["ck_messages"], "native":response["native_messages"]}))
        .unwrap()
}

fn median(values: &mut [f64]) -> f64 {
    values.sort_by(f64::total_cmp);
    let n = values.len();
    if n.is_multiple_of(2) {
        (values[n / 2 - 1] + values[n / 2]) / 2.0
    } else {
        values[n / 2]
    }
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "copy-only release profile; see docs/reports/ckmc-per-pass-cost.md"]
async fn copied_sessions_per_pass_cost() {
    if cfg!(debug_assertions) {
        panic!("use --release for meaningful timings");
    }
    let references = references_enabled(std::env::var("MC_PER_PASS_REFERENCES").ok().as_deref());
    let _differentials = DifferentialOverride::new(references);
    println!("COST_CONFIG {}", json!({"references": references}));
    let temp = std::env::temp_dir().canonicalize().unwrap();
    let root = temp.join("magic-context/ckmc-perf").canonicalize().expect(
        "copy-only profile needs existing scrubbed backups; never recreate from live stores",
    );
    assert!(
        root.starts_with(&temp),
        "scratch root must stay in the temporary directory"
    );
    let backups = root
        .join("backups")
        .canonicalize()
        .expect("scrubbed backups are missing; do not copy live stores for this profile");
    assert!(backups.starts_with(&root));
    for name in ["context.db", "store.db"] {
        let path = backups.join(name).canonicalize().unwrap();
        assert!(path.starts_with(&root));
        assert!(
            std::fs::metadata(path).unwrap().permissions().readonly(),
            "backups must be read-only"
        );
    }
    let sessions = std::env::var("MC_PER_PASS_SESSIONS").unwrap_or_else(|_| {
        "ses_227ce5788ffeRPA9THoPLOQreO:7500,ses_0758f6ce7ffeJ0A9sV8Qvema7d:1875,ses_f6f7af30bffeayPgWk5XJtq5YW:568".into()
    });
    let samples: usize = std::env::var("MC_PER_PASS_SAMPLES")
        .ok()
        .map(|v| v.parse().unwrap())
        .unwrap_or(20);
    assert!(samples >= 20, "at least 20 samples per configuration");
    for spec in sessions.split(',') {
        let (session, limit) = spec.split_once(':').unwrap();
        let dir = tempfile::Builder::new()
            .prefix("run-")
            .tempdir_in(&root)
            .unwrap();
        for name in ["context.db", "store.db"] {
            copy_backup(&backups.join(name), &dir.path().join(name));
        }
        let conn = rusqlite::Connection::open(dir.path().join("store.db")).unwrap();
        conn.execute("DELETE FROM cortexkit_fence", []).unwrap();
        // Filler cannot match the host's content fingerprints. Only the writable
        // experiment clone adopts new pins; keep coverage and frozen payloads.
        conn.execute(
            "DELETE FROM mc_block_identities WHERE session_id=?1",
            [session],
        )
        .unwrap();
        drop(conn);
        let descriptor = StorageDescriptor {
            module_id: "magic-context".into(),
            storage_namespace: "magic-context".into(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: dir.path().join("store.db").to_string_lossy().into_owned(),
            },
        };
        let store = Arc::new(McStore::open(&descriptor).unwrap());
        single_store_reads::attach(&store, &dir.path().join("context.db")).unwrap();
        let original = store.load(session).unwrap();
        // A copied live producer run cannot be reattached by an offline profile.
        // Keep the boundary/trigger policy path, but make this clone idle so no
        // recovery task races the normalization or starts external production.
        let mut offline_meta = original.meta.clone();
        offline_meta.historian = HistorianDurableState::default();
        store
            .commit_meta(session, original.row_version, &offline_meta)
            .unwrap();
        let mut messages = shape(&store, &backups, session, limit.parse().unwrap());
        let handler = McHandler::with_producer_factory_config_resolver(
            Arc::new(MissingProducerFactory),
            default_test_config(),
            Arc::new(MissingSessionResolver),
        );
        handler.store.set(Arc::clone(&store)).ok().unwrap();
        let project = dir.path().join("empty-project");
        std::fs::create_dir(&project).unwrap();
        let mut route = binding_with_harness(project.to_str().unwrap(), "opencode", session);
        route.config.inject_docs = false;
        handler.bind_route(7, route);
        let base = json!({"method":"transform","kind":"transform","v":2,
            "serializer_profile":"opencode-aisdk","session_id":session,"render_config":"cost-profile",
            "provider_id":"anthropic","model_key":"anthropic/claude-opus-5-5",
            "serve_native":true,"tool_present":true,"todo_tool_present":false,
            "todo_verdict_probed":true,"mid_turn":true,"cache_ttl":"never",
            "historian_model_chain":[],"auto_search_enabled":false,
            "usage":{"input_tokens":1000,"percentage":1,"context_limit":200000}});
        let mut request = base.clone();
        request["messages"] = serde_json::to_value(&messages).unwrap();
        request["native_messages"] = json!(native(&messages, session));
        request["full_array_fingerprint"] = json!("normalize");
        let initial = call_transform_request_on_channel(&handler, 7, request).await;
        let mut served_native = initial["native_messages"].as_array().unwrap().clone();
        // Normalizing render identity can HARD-fold and retire historical units.
        // Restore the original historical vector plus the normalized frames so
        // measured defers have the real session's persisted-state scale.
        let mut normalized = store.load(session).unwrap();
        let frames: Vec<_> = normalized
            .core
            .frozen_units
            .iter()
            .filter(|u| matches!(u.key.as_str(), "m0" | "m1"))
            .cloned()
            .collect();
        normalized.core.frozen_units = original
            .core
            .frozen_units
            .into_iter()
            .filter(|u| !matches!(u.key.as_str(), "m0" | "m1"))
            .collect();
        normalized.core.frozen_units.extend(frames);
        store
            .commit(
                session,
                normalized.row_version,
                &normalized.core,
                &normalized.meta,
            )
            .unwrap();
        let mut expected = Vec::new();
        let mut after = "normalize".to_string();
        for mode in ["warm_delta", "warm_full", "evicted_full"] {
            let load = Command::new("uptime").output().unwrap();
            println!(
                "COST_RUN {}",
                json!({"session":session,"mode":mode,"samples":samples,
                "references":references,
                "load":String::from_utf8_lossy(&load.stdout).trim(),
                "messages":messages.len(),"original_frozen_units":normalized.core.frozen_units.len()})
            );
            let mut measurements: BTreeMap<String, Vec<per_pass_profile::Cost>> = BTreeMap::new();
            for pass in 0..samples + 3 {
                let label = format!("live-{pass}");
                messages.last_mut().unwrap().ck.content =
                    vec![CkWireBlock::bare(CkKind::Text { text: label })];
                let mut native_messages = native(&messages[messages.len() - 2..], session);
                let mut request = base.clone();
                let fingerprint = format!("{mode}-{pass}");
                request["full_array_fingerprint"] = json!(fingerprint);
                if mode == "warm_delta" {
                    let native_count = native(&messages, session).len();
                    request["messages"] =
                        serde_json::to_value(&messages[messages.len() - 2..]).unwrap();
                    request["tail_delta"] = json!({"after":after,"replace_from":messages.len()-2,
                        "native_replace_from":native_count-native_messages.len()});
                } else {
                    request["messages"] = serde_json::to_value(&messages).unwrap();
                    native_messages = native(&messages, session);
                    if mode == "evicted_full" {
                        handler.projections.lock().unwrap().remove(session);
                        handler.native_attachments.lock().unwrap().remove(session);
                    }
                }
                request["native_messages"] = json!(native_messages);
                per_pass_profile::begin_pass();
                let mut response = call_transform_request_on_channel(&handler, 7, request).await;
                let costs = per_pass_profile::end_pass();
                if !references {
                    assert!(
                        !costs.contains_key("projection_differential")
                            && !costs.contains_key("native_differential"),
                        "production-equivalent profile must not include correctness references"
                    );
                }
                assert_ne!(response["status"], "need_full_sync", "delta must execute");
                assert_ne!(response["action"], "NEED_FULL_SYNC", "delta must execute");
                if pass >= 3 {
                    assert_eq!(
                        response["decision"], "SOFT+",
                        "measure stable defers, not rebuilds"
                    );
                }
                assert!(response["ck_messages"].is_array());
                if let Some(full) = response["native_messages"].as_array() {
                    served_native = full.clone();
                } else {
                    let delta = &response["native_messages_delta"];
                    assert_eq!(delta["after"], after);
                    let cut = delta["replace_from"].as_u64().unwrap() as usize;
                    assert!(cut <= served_native.len());
                    served_native.truncate(cut);
                    served_native.extend(delta["messages"].as_array().unwrap().iter().cloned());
                }
                // Compare complete provider arrays, not a full response with a
                // delta envelope or an absent native_messages placeholder.
                response["native_messages"] = json!(served_native);
                after = fingerprint;
                if pass < 3 {
                    continue;
                }
                let bytes = output_bytes(&response);
                if mode == "warm_delta" {
                    expected.push(bytes.clone());
                } else {
                    assert_eq!(
                        bytes,
                        expected[pass - 3],
                        "wire arrays must agree across modes"
                    );
                }
                println!(
                    "COST_SAMPLE {}",
                    json!({"session":session,"mode":mode,"pass":pass-3,
                    "references":references,
                    "costs":costs,"timings":response["timings"],"wire_sha256":sha256_hex(&bytes)})
                );
                for (stage, cost) in costs {
                    measurements.entry(stage.into()).or_default().push(cost);
                }
            }
            let summary: BTreeMap<_, _> = measurements
                .into_iter()
                .map(|(stage, costs)| {
                    let mut wall: Vec<_> = costs.iter().map(|c| c.wall_ms).collect();
                    let mut cpu: Vec<_> = costs.iter().map(|c| c.thread_cpu_ms).collect();
                    (
                        stage,
                        json!({"n":costs.len(),"wall_p50_ms":median(&mut wall),
                    "thread_cpu_p50_ms":median(&mut cpu),"wall_max_ms":wall.last()}),
                    )
                })
                .collect();
            println!(
                "COST_SUMMARY {}",
                json!({"session":session,"mode":mode,"references":references,"stages":summary})
            );
        }
    }
}
