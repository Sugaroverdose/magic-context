//! The claim lane for historian runs whose completion something outside this
//! module runs.
//!
//! A run enters the lane when the module has assembled a chunk and built the
//! prompt but has no producer of its own to send it to. The run is queued, a
//! claimant takes it under a lease, and the module accepts exactly one terminal
//! report per claim. Everything else about the firing — chunking, validation,
//! the publish CAS, the failure taxonomy — is unchanged and stays where it is.
//!
//! Two rules make this safe without trusting the claimant:
//!
//! 1. The module mints the attempt number and the token. A claimant never
//!    chooses either, so it cannot forge a newer claim than the one it holds.
//! 2. What a report presents is the token, not an identity. A claimant that
//!    stalled and was replaced still holds a real token, but not the CURRENT
//!    one, so its late report is refused before its output is parsed. Refusing
//!    on identity instead would let a restarted claimant with the same install
//!    identity publish over its own replacement.

use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::{params, OptionalExtension};
use sha2::{Digest, Sha256};

use crate::{HistorianDurableState, HistorianPhase, McStore, McStoreError, ModuleMeta};

/// The longest a claim may hold a run before another claimant may take it.
///
/// A fold legitimately runs for minutes, so the lease cannot be short. It also
/// cannot be unbounded: a claimant that dies silently would park the run forever.
/// The ceiling is the module's own producer await, which is the longest a run has
/// ever been allowed to take.
pub const HISTORIAN_LEASE_CEILING_MS: i64 = 600_000;

/// How often a live claimant is expected to extend its lease. Two missed beats
/// plus a margin is what turns "slow" into "gone", so a working claimant is never
/// stolen from and a dead one is replaced in about a minute rather than ten.
pub const HISTORIAN_HEARTBEAT_INTERVAL_MS: i64 = 30_000;

/// Queue phase written to `mc_historian_pending_run.phase`.
const PHASE_PENDING: &str = "pending";
const PHASE_CLAIMED: &str = "claimed";

/// Resolve the lease a claim gets from the run's configured await budget.
pub fn historian_lease_ms(await_budget_ms: i64) -> i64 {
    await_budget_ms.clamp(1, HISTORIAN_LEASE_CEILING_MS)
}

/// A run queued for a claimant, in the shape `historian.pending` answers with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistorianPendingRun {
    pub run_id: String,
    pub session_id: String,
    pub chunk_fingerprint: String,
    /// UTF-8 bytes of the system prompt plus the user prompt — exactly the two
    /// strings `historian.claim` hands back, so a claimant can size the request
    /// before taking it.
    pub prompt_bytes_len: u64,
    /// When the run itself stops being worth running, not when the current lease
    /// expires. A run past this deadline is never handed out again.
    pub deadline_ms: i64,
}

/// Everything needed to queue one run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewHistorianPendingRun {
    pub run_id: String,
    pub session_id: String,
    pub project_path: String,
    pub firing_seq: u64,
    pub chunk_fingerprint: String,
    pub system_prompt: String,
    pub user_prompt: String,
    pub model_chain: Vec<String>,
    pub await_budget_ms: i64,
    pub now_ms: i64,
}

/// What a successful `historian.claim` hands back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistorianClaim {
    pub run_id: String,
    pub session_id: String,
    pub attempt: u32,
    pub token: String,
    pub system_prompt: String,
    pub user_prompt: String,
    pub model_chain: Vec<String>,
    pub await_budget_ms: i64,
    pub claim_deadline_ms: i64,
}

/// Why a claim was refused. Each maps to one wire code so a claimant can tell
/// "someone beat me to it" from "that run never existed".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistorianClaimRefusal {
    /// No queue row with that id: never queued, already terminal, or expired.
    UnknownRun,
    /// The run exists but is not waiting for a claimant.
    NotPending,
    /// The run is already held by a claimant whose lease has not expired.
    AlreadyClaimed,
}

impl HistorianClaimRefusal {
    pub fn as_wire_str(self) -> &'static str {
        match self {
            HistorianClaimRefusal::UnknownRun => "unknown_run",
            HistorianClaimRefusal::NotPending => "not_pending",
            HistorianClaimRefusal::AlreadyClaimed => "already_claimed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HistorianClaimOutcome {
    Claimed(Box<HistorianClaim>),
    Refused(HistorianClaimRefusal),
}

/// Why a heartbeat or a terminal report was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistorianReportRefusal {
    UnknownRun,
    /// The run exists but nobody holds it, so no token can be current.
    NotClaimed,
    /// The token was real once. The claim it belonged to is over, so whatever
    /// this report carries describes an attempt that no longer exists.
    SupersededToken,
}

impl HistorianReportRefusal {
    pub fn as_wire_str(self) -> &'static str {
        match self {
            HistorianReportRefusal::UnknownRun => "unknown_run",
            HistorianReportRefusal::NotClaimed => "not_claimed",
            HistorianReportRefusal::SupersededToken => "superseded_token",
        }
    }
}

/// The run identity a verified report is allowed to act on. The caller validates
/// and publishes under exactly this pair.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistorianReportAuthorization {
    pub run_id: String,
    pub session_id: String,
    pub attempt: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HistorianReportOutcome {
    Authorized(HistorianReportAuthorization),
    Refused(HistorianReportRefusal),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HistorianHeartbeatOutcome {
    /// The lease now runs until this wall-clock time.
    Extended {
        claim_deadline_ms: i64,
    },
    Refused(HistorianReportRefusal),
}

impl HistorianDurableState {
    /// Drop the claim but keep the run: `run_id`, chunk fingerprint, selected
    /// identities and `firing_seq` all survive, so the next claimant continues this
    /// run instead of paying to assemble a new chunk. Clearing the token is what
    /// makes the departing claimant's late report refusable.
    pub fn park_for_reclaim(&mut self) {
        self.state = HistorianPhase::Reclaiming;
        self.coordinator_token = None;
        self.claim_deadline_ms = None;
    }

    /// Hand the run to a claimant under a module-minted attempt and token.
    pub fn grant_claim(&mut self, attempt: u32, token: String, claim_deadline_ms: i64) {
        self.state = HistorianPhase::AwaitingProducer;
        self.producer_attempt = attempt;
        self.coordinator_token = Some(token);
        self.claim_deadline_ms = Some(claim_deadline_ms);
        // A claim establishes a producer run, so whatever cooldown or failure
        // detail preceded it is resolved — the same rule the in-module producer
        // path applies when its own run starts.
        self.failure_backoff_at_ms = None;
        self.last_failure = None;
    }

    /// Whether the current claim has stopped being current.
    pub fn claim_expired(&self, now_ms: i64) -> bool {
        self.claim_deadline_ms
            .is_some_and(|deadline| deadline <= now_ms)
    }
}

/// Distinguishes tokens minted in the same millisecond for the same run.
static TOKEN_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Mint the secret a claim is identified by.
///
/// `(run_id, attempt)` is already unique, so uniqueness costs nothing here; the
/// hash exists so a claimant that knows a run id cannot derive the token of a
/// claim it does not hold.
fn mint_token(run_id: &str, attempt: u32, claimant_instance_id: &str, now_ms: i64) -> String {
    let sequence = TOKEN_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let mut hasher = Sha256::new();
    hasher.update(run_id.as_bytes());
    hasher.update([0u8]);
    hasher.update(attempt.to_le_bytes());
    hasher.update(claimant_instance_id.as_bytes());
    hasher.update([0u8]);
    hasher.update(now_ms.to_le_bytes());
    hasher.update(sequence.to_le_bytes());
    hasher.update(std::process::id().to_le_bytes());
    let digest = hasher.finalize();
    digest.iter().take(16).map(|b| format!("{b:02x}")).collect()
}

/// Read a session's meta and its row version inside an open transaction.
fn load_meta(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
) -> rusqlite::Result<Option<(i64, ModuleMeta)>> {
    let row = tx
        .query_row(
            "SELECT row_version, meta FROM mc_cache_state WHERE session_id = ?1",
            params![session_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    let Some((row_version, meta_json)) = row else {
        return Ok(None);
    };
    match serde_json::from_str::<ModuleMeta>(&meta_json) {
        Ok(meta) => Ok(Some((row_version, meta))),
        // A meta blob this connection cannot read is not something a claim may
        // repair; report it as "no session" so the caller refuses rather than
        // overwriting a row it did not understand.
        Err(_) => Ok(None),
    }
}

/// Write a session's meta back under the row version it was read at.
fn store_meta(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
    current_row_version: i64,
    meta: &ModuleMeta,
) -> rusqlite::Result<u64> {
    let next = current_row_version.max(0) as u64 + 1;
    let meta_json = serde_json::to_string(meta).map_err(|error| {
        rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(error.to_string())))
    })?;
    tx.execute(
        "UPDATE mc_cache_state SET row_version = ?2, meta = ?3
         WHERE session_id = ?1 AND row_version = ?4",
        params![session_id, next as i64, meta_json, current_row_version],
    )?;
    Ok(next)
}

impl McStore {
    /// Queue a fired run for a claimant and park the session on `Reclaiming`.
    ///
    /// Both writes land in one transaction: a queue row whose session is not
    /// parked would be handed to a claimant whose claim could never be admitted,
    /// and a parked session with no queue row would never be claimed at all.
    pub fn publish_pending_historian_run(
        &self,
        run: &NewHistorianPendingRun,
    ) -> Result<u64, McStoreError> {
        let deadline_ms = run.now_ms.saturating_add(run.await_budget_ms.max(0));
        let lease_ms = historian_lease_ms(run.await_budget_ms);
        let model_chain = serde_json::to_string(&run.model_chain)
            .map_err(|error| McStoreError::Serde(error.to_string()))?;
        let outcome = self.inner.with_conn_fenced(|tx| {
            let Some((row_version, mut meta)) = load_meta(tx, &run.session_id)? else {
                return Ok(None);
            };
            if meta.historian.state != HistorianPhase::Firing {
                return Ok(None);
            }
            meta.historian.producer_run_id = Some(run.run_id.clone());
            meta.historian.producer_attempt = 0;
            meta.historian.park_for_reclaim();
            let next = store_meta(tx, &run.session_id, row_version, &meta)?;
            tx.execute(
                "INSERT OR REPLACE INTO mc_historian_pending_run (
                     run_id, session_id, project_path, firing_seq, chunk_fingerprint,
                     phase, attempt, claimant_instance_id, coordinator_token,
                     claim_deadline_ms, lease_ms, deadline_ms, system_prompt, user_prompt,
                     model_chain, await_budget_ms, created_at_ms, updated_at_ms
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, NULL, NULL, NULL, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)",
                params![
                    run.run_id,
                    run.session_id,
                    run.project_path,
                    run.firing_seq as i64,
                    run.chunk_fingerprint,
                    PHASE_PENDING,
                    lease_ms,
                    deadline_ms,
                    run.system_prompt,
                    run.user_prompt,
                    model_chain,
                    run.await_budget_ms,
                    run.now_ms,
                ],
            )?;
            Ok(Some(next))
        })?;
        outcome.ok_or_else(|| {
            McStoreError::Serde(format!(
                "historian run {} cannot be queued: session {} is not firing",
                run.run_id, run.session_id
            ))
        })
    }

    /// Runs waiting for a claimant, newest-queued last.
    ///
    /// A run whose own deadline has passed is not offered: taking it would spend a
    /// provider call on output the module has already stopped waiting for.
    pub fn list_pending_historian_runs(
        &self,
        session_id: Option<&str>,
        now_ms: i64,
    ) -> Result<Vec<HistorianPendingRun>, McStoreError> {
        let rows = self.inner.with_conn_fenced(|tx| {
            let mut statement = tx.prepare(
                "SELECT run_id, session_id, chunk_fingerprint,
                        LENGTH(CAST(system_prompt AS BLOB)) + LENGTH(CAST(user_prompt AS BLOB)),
                        deadline_ms, phase, claim_deadline_ms
                   FROM mc_historian_pending_run
                  WHERE (?1 IS NULL OR session_id = ?1)
                    AND deadline_ms > ?2
                  ORDER BY created_at_ms ASC, run_id ASC",
            )?;
            let mapped = statement
                .query_map(params![session_id, now_ms], |row| {
                    Ok((
                        HistorianPendingRun {
                            run_id: row.get(0)?,
                            session_id: row.get(1)?,
                            chunk_fingerprint: row.get(2)?,
                            prompt_bytes_len: row.get::<_, i64>(3)?.max(0) as u64,
                            deadline_ms: row.get(4)?,
                        },
                        row.get::<_, String>(5)?,
                        row.get::<_, Option<i64>>(6)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(mapped)
        })?;
        Ok(rows
            .into_iter()
            .filter(|(_, phase, claim_deadline_ms)| is_claimable(phase, *claim_deadline_ms, now_ms))
            .map(|(run, _, _)| run)
            .collect())
    }

    /// Take a queued run under a fresh attempt and token.
    ///
    /// The queue row and the session's phase move together so a claimant that is
    /// told it won always finds the session ready to accept its report.
    pub fn claim_historian_run(
        &self,
        run_id: &str,
        claimant_instance_id: &str,
        now_ms: i64,
    ) -> Result<HistorianClaimOutcome, McStoreError> {
        let outcome = self.inner.with_conn_fenced(|tx| {
            let row = tx
                .query_row(
                    "SELECT session_id, phase, attempt, claim_deadline_ms, lease_ms,
                            deadline_ms, system_prompt, user_prompt, model_chain, await_budget_ms
                       FROM mc_historian_pending_run WHERE run_id = ?1",
                    params![run_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, Option<i64>>(3)?,
                            row.get::<_, i64>(4)?,
                            row.get::<_, i64>(5)?,
                            row.get::<_, String>(6)?,
                            row.get::<_, String>(7)?,
                            row.get::<_, String>(8)?,
                            row.get::<_, i64>(9)?,
                        ))
                    },
                )
                .optional()?;
            let Some((
                session_id,
                phase,
                attempt,
                claim_deadline_ms,
                lease_ms,
                deadline_ms,
                system_prompt,
                user_prompt,
                model_chain,
                await_budget_ms,
            )) = row
            else {
                return Ok(HistorianClaimOutcome::Refused(
                    HistorianClaimRefusal::UnknownRun,
                ));
            };
            if deadline_ms <= now_ms {
                return Ok(HistorianClaimOutcome::Refused(
                    HistorianClaimRefusal::NotPending,
                ));
            }
            if !is_claimable(&phase, claim_deadline_ms, now_ms) {
                return Ok(HistorianClaimOutcome::Refused(if phase == PHASE_CLAIMED {
                    HistorianClaimRefusal::AlreadyClaimed
                } else {
                    HistorianClaimRefusal::NotPending
                }));
            }

            let Some((row_version, mut meta)) = load_meta(tx, &session_id)? else {
                return Ok(HistorianClaimOutcome::Refused(
                    HistorianClaimRefusal::UnknownRun,
                ));
            };
            if meta.historian.producer_run_id.as_deref() != Some(run_id) {
                return Ok(HistorianClaimOutcome::Refused(
                    HistorianClaimRefusal::NotPending,
                ));
            }
            // AwaitingProducer -> Reclaiming. A claimant can arrive before the sweep
            // that would otherwise park the session, so the expiry transition runs
            // here too rather than making the claimant wait for a sweep to notice.
            // It keeps run_id, chunk fingerprint and firing_seq and drops only the
            // claim, which is what lets the replacement continue the same run.
            if meta.historian.state == HistorianPhase::AwaitingProducer
                && meta.historian.claim_expired(now_ms)
            {
                meta.historian.park_for_reclaim();
            }
            // Any phase other than the parked one means the run moved on (published,
            // abandoned, or refired) since the queue row was written, so the row is
            // stale rather than claimable.
            if meta.historian.state != HistorianPhase::Reclaiming {
                return Ok(HistorianClaimOutcome::Refused(
                    HistorianClaimRefusal::NotPending,
                ));
            }

            let next_attempt = (attempt.max(0) as u32).saturating_add(1);
            let token = mint_token(run_id, next_attempt, claimant_instance_id, now_ms);
            let claim_deadline_ms = now_ms.saturating_add(lease_ms).min(deadline_ms);

            meta.historian
                .grant_claim(next_attempt, token.clone(), claim_deadline_ms);
            store_meta(tx, &session_id, row_version, &meta)?;

            tx.execute(
                "UPDATE mc_historian_pending_run
                    SET phase = ?2, attempt = ?3, claimant_instance_id = ?4,
                        coordinator_token = ?5, claim_deadline_ms = ?6, updated_at_ms = ?7
                  WHERE run_id = ?1",
                params![
                    run_id,
                    PHASE_CLAIMED,
                    next_attempt as i64,
                    claimant_instance_id,
                    token,
                    claim_deadline_ms,
                    now_ms,
                ],
            )?;

            let model_chain: Vec<String> = serde_json::from_str(&model_chain).unwrap_or_default();
            Ok(HistorianClaimOutcome::Claimed(Box::new(HistorianClaim {
                run_id: run_id.to_string(),
                session_id,
                attempt: next_attempt,
                token,
                system_prompt,
                user_prompt,
                model_chain,
                await_budget_ms,
                claim_deadline_ms,
            })))
        })?;
        Ok(outcome)
    }

    /// Extend the current claim's lease. Only the holder of the current token can.
    pub fn heartbeat_historian_run(
        &self,
        run_id: &str,
        token: &str,
        now_ms: i64,
    ) -> Result<HistorianHeartbeatOutcome, McStoreError> {
        let outcome = self.inner.with_conn_fenced(|tx| {
            let Some(claim) = read_claim(tx, run_id)? else {
                return Ok(HistorianHeartbeatOutcome::Refused(
                    HistorianReportRefusal::UnknownRun,
                ));
            };
            let session_id = claim.session_id;
            let Some(stored_token) = claim.coordinator_token else {
                return Ok(HistorianHeartbeatOutcome::Refused(
                    HistorianReportRefusal::NotClaimed,
                ));
            };
            if stored_token != token {
                return Ok(HistorianHeartbeatOutcome::Refused(
                    HistorianReportRefusal::SupersededToken,
                ));
            }
            let claim_deadline_ms = now_ms.saturating_add(claim.lease_ms).min(claim.deadline_ms);
            tx.execute(
                "UPDATE mc_historian_pending_run
                    SET claim_deadline_ms = ?2, updated_at_ms = ?3
                  WHERE run_id = ?1",
                params![run_id, claim_deadline_ms, now_ms],
            )?;
            if let Some((row_version, mut meta)) = load_meta(tx, &session_id)? {
                if meta.historian.coordinator_token.as_deref() == Some(token) {
                    meta.historian.claim_deadline_ms = Some(claim_deadline_ms);
                    store_meta(tx, &session_id, row_version, &meta)?;
                }
            }
            Ok(HistorianHeartbeatOutcome::Extended { claim_deadline_ms })
        })?;
        Ok(outcome)
    }

    /// Check that a terminal report belongs to the current claim.
    ///
    /// This deliberately does not change the phase. The report still has to pass
    /// validation and the publish CAS, both of which own their own transitions;
    /// moving the phase here would make a rejected report look published.
    pub fn authorize_historian_report(
        &self,
        run_id: &str,
        token: &str,
    ) -> Result<HistorianReportOutcome, McStoreError> {
        let outcome = self.inner.with_conn_fenced(|tx| {
            let Some(claim) = read_claim(tx, run_id)? else {
                return Ok(HistorianReportOutcome::Refused(
                    HistorianReportRefusal::UnknownRun,
                ));
            };
            let session_id = claim.session_id;
            let Some(stored_token) = claim.coordinator_token else {
                return Ok(HistorianReportOutcome::Refused(
                    HistorianReportRefusal::NotClaimed,
                ));
            };
            if stored_token != token {
                return Ok(HistorianReportOutcome::Refused(
                    HistorianReportRefusal::SupersededToken,
                ));
            }
            let Some((_row_version, meta)) = load_meta(tx, &session_id)? else {
                return Ok(HistorianReportOutcome::Refused(
                    HistorianReportRefusal::UnknownRun,
                ));
            };
            // The queue row and the session state are written together, so a
            // disagreement between them means this report raced a transition that
            // has already superseded its claim.
            if meta.historian.coordinator_token.as_deref() != Some(token)
                || meta.historian.producer_run_id.as_deref() != Some(run_id)
            {
                return Ok(HistorianReportOutcome::Refused(
                    HistorianReportRefusal::SupersededToken,
                ));
            }
            Ok(HistorianReportOutcome::Authorized(
                HistorianReportAuthorization {
                    run_id: run_id.to_string(),
                    session_id,
                    attempt: meta.historian.producer_attempt,
                },
            ))
        })?;
        Ok(outcome)
    }

    /// Drop a queue row on any terminal outcome. Terminal runs are removed rather
    /// than marked so the queue stays the size of the work actually outstanding.
    pub fn finish_historian_pending_run(&self, run_id: &str) -> Result<bool, McStoreError> {
        let removed = self.inner.with_conn_fenced(|tx| {
            tx.execute(
                "DELETE FROM mc_historian_pending_run WHERE run_id = ?1",
                params![run_id],
            )
        })?;
        Ok(removed > 0)
    }

    /// Return every run whose claimant stopped reporting to the queue, and park
    /// its session so the next claimant continues the same run.
    ///
    /// The run keeps its `run_id`, its chunk and its firing sequence: only the
    /// claim is dropped. That is what makes a re-claim cheap — the replacement
    /// claimant pays for one completion, not for re-assembling the chunk.
    pub fn expire_historian_claims(&self, now_ms: i64) -> Result<Vec<String>, McStoreError> {
        let expired = self.inner.with_conn_fenced(|tx| {
            let mut statement = tx.prepare(
                "SELECT run_id, session_id FROM mc_historian_pending_run
                  WHERE phase = ?1 AND claim_deadline_ms IS NOT NULL AND claim_deadline_ms <= ?2",
            )?;
            let rows = statement
                .query_map(params![PHASE_CLAIMED, now_ms], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            drop(statement);

            let mut reclaimed = Vec::new();
            for (run_id, session_id) in rows {
                tx.execute(
                    "UPDATE mc_historian_pending_run
                        SET phase = ?2, claimant_instance_id = NULL, coordinator_token = NULL,
                            claim_deadline_ms = NULL, updated_at_ms = ?3
                      WHERE run_id = ?1",
                    params![run_id, PHASE_PENDING, now_ms],
                )?;
                if let Some((row_version, mut meta)) = load_meta(tx, &session_id)? {
                    if meta.historian.state == HistorianPhase::AwaitingProducer
                        && meta.historian.producer_run_id.as_deref() == Some(run_id.as_str())
                    {
                        meta.historian.park_for_reclaim();
                        store_meta(tx, &session_id, row_version, &meta)?;
                    }
                }
                reclaimed.push(run_id);
            }
            Ok(reclaimed)
        })?;
        Ok(expired)
    }

    /// The durable historian state for one session, for tests and diagnostics.
    pub fn historian_state(&self, session_id: &str) -> Result<HistorianDurableState, McStoreError> {
        Ok(self.load(session_id)?.meta.historian)
    }
}

/// The claim-bearing columns of one queue row.
struct StoredClaim {
    session_id: String,
    /// Absent while no claimant holds the run.
    coordinator_token: Option<String>,
    lease_ms: i64,
    /// When the run itself expires, which caps every lease granted on it.
    deadline_ms: i64,
}

fn read_claim(
    tx: &rusqlite::Transaction<'_>,
    run_id: &str,
) -> rusqlite::Result<Option<StoredClaim>> {
    tx.query_row(
        "SELECT session_id, coordinator_token, lease_ms, deadline_ms
           FROM mc_historian_pending_run WHERE run_id = ?1",
        params![run_id],
        |row| {
            Ok(StoredClaim {
                session_id: row.get(0)?,
                coordinator_token: row.get(1)?,
                lease_ms: row.get(2)?,
                deadline_ms: row.get(3)?,
            })
        },
    )
    .optional()
}

/// A run is claimable when nobody holds it, or when whoever held it stopped
/// extending the lease. The expired-lease case is checked here rather than only
/// in the sweep so a claimant that arrives before the sweep runs is not told the
/// run is busy when it is in fact abandoned.
fn is_claimable(phase: &str, claim_deadline_ms: Option<i64>, now_ms: i64) -> bool {
    match phase {
        PHASE_PENDING => true,
        PHASE_CLAIMED => claim_deadline_ms.is_some_and(|deadline| deadline <= now_ms),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CoreState, ModuleMeta};
    use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};

    const AWAIT_BUDGET_MS: i64 = 660_000;

    fn open_store(dir: &std::path::Path) -> McStore {
        McStore::open(&StorageDescriptor {
            module_id: "magic-context-test".to_string(),
            storage_namespace: "mc_cache".to_string(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: dir.join("store.db").to_string_lossy().to_string(),
            },
        })
        .unwrap()
    }

    /// Seed a session in the phase a firing reaches just before its completion
    /// runs, then queue that run for a claimant.
    fn queue_run(store: &McStore, run_id: &str, session_id: &str, now_ms: i64) {
        let loaded = store.load(session_id).unwrap();
        let mut meta = ModuleMeta::default();
        meta.historian.state = HistorianPhase::Firing;
        meta.historian.firing_seq = 1;
        meta.historian.chunk_fingerprint = "fp".to_string();
        store
            .commit(session_id, loaded.row_version, &CoreState::default(), &meta)
            .unwrap();
        store
            .publish_pending_historian_run(&NewHistorianPendingRun {
                run_id: run_id.to_string(),
                session_id: session_id.to_string(),
                project_path: "git:proj".to_string(),
                firing_seq: 1,
                chunk_fingerprint: "fp".to_string(),
                system_prompt: "sys".to_string(),
                user_prompt: "user".to_string(),
                model_chain: vec!["test/model".to_string()],
                await_budget_ms: AWAIT_BUDGET_MS,
                now_ms,
            })
            .unwrap();
    }

    #[test]
    fn queueing_a_run_parks_the_session_and_offers_it() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(dir.path());
        queue_run(&store, "run-1", "ses", 1_000);

        let state = store.historian_state("ses").unwrap();
        assert_eq!(state.state, HistorianPhase::Reclaiming);
        assert_eq!(state.producer_run_id.as_deref(), Some("run-1"));
        assert_eq!(state.coordinator_token, None);

        let pending = store.list_pending_historian_runs(None, 2_000).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].run_id, "run-1");
        assert_eq!(pending[0].session_id, "ses");
        assert_eq!(pending[0].deadline_ms, 1_000 + AWAIT_BUDGET_MS);
        assert_eq!(
            pending[0].prompt_bytes_len,
            "sys".len() as u64 + "user".len() as u64
        );
    }

    #[test]
    fn a_run_whose_own_deadline_passed_is_never_offered_again() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(dir.path());
        queue_run(&store, "run-1", "ses", 1_000);
        let after_deadline = 1_000 + AWAIT_BUDGET_MS + 1;

        assert!(store
            .list_pending_historian_runs(None, after_deadline)
            .unwrap()
            .is_empty());
        assert_eq!(
            store
                .claim_historian_run("run-1", "install-one", after_deadline)
                .unwrap(),
            HistorianClaimOutcome::Refused(HistorianClaimRefusal::NotPending)
        );
    }

    #[test]
    fn the_sweep_parks_a_claim_whose_lease_ran_out_and_leaves_a_live_one_alone() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(dir.path());
        queue_run(&store, "run-dead", "ses-dead", 1_000);
        queue_run(&store, "run-live", "ses-live", 1_000);
        store
            .claim_historian_run("run-dead", "install-one", 1_000)
            .unwrap();
        store
            .claim_historian_run("run-live", "install-two", 1_000)
            .unwrap();

        // One millisecond before either lease ends, nothing is swept.
        let lease_end = 1_000 + HISTORIAN_LEASE_CEILING_MS;
        assert!(store
            .expire_historian_claims(lease_end - 1)
            .unwrap()
            .is_empty());

        // The live claimant extends its lease; the dead one does not.
        let live_token = match store
            .claim_historian_run("run-live", "install-three", lease_end - 1)
            .unwrap()
        {
            HistorianClaimOutcome::Refused(HistorianClaimRefusal::AlreadyClaimed) => store
                .historian_state("ses-live")
                .unwrap()
                .coordinator_token
                .expect("the live claim keeps its token"),
            other => panic!("a live lease must not be stealable: {other:?}"),
        };
        store
            .heartbeat_historian_run("run-live", &live_token, lease_end - 1)
            .unwrap();

        assert_eq!(
            store.expire_historian_claims(lease_end).unwrap(),
            vec!["run-dead".to_string()]
        );
        assert_eq!(
            store.historian_state("ses-dead").unwrap().state,
            HistorianPhase::Reclaiming
        );
        assert_eq!(
            store.historian_state("ses-live").unwrap().state,
            HistorianPhase::AwaitingProducer,
            "a claimant that keeps reporting is never stolen from"
        );
    }

    #[test]
    fn a_heartbeat_never_pushes_a_lease_past_the_run_itself() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(dir.path());
        queue_run(&store, "run-1", "ses", 1_000);
        let HistorianClaimOutcome::Claimed(claim) = store
            .claim_historian_run("run-1", "install-one", 1_000)
            .unwrap()
        else {
            panic!("the first claimant must win");
        };
        let run_deadline_ms = 1_000 + AWAIT_BUDGET_MS;
        let late = run_deadline_ms - 1;
        assert_eq!(
            store
                .heartbeat_historian_run("run-1", &claim.token, late)
                .unwrap(),
            HistorianHeartbeatOutcome::Extended {
                claim_deadline_ms: run_deadline_ms
            }
        );
    }

    #[test]
    fn finishing_a_run_removes_it_from_the_queue() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(dir.path());
        queue_run(&store, "run-1", "ses", 1_000);
        assert!(store.finish_historian_pending_run("run-1").unwrap());
        assert!(!store.finish_historian_pending_run("run-1").unwrap());
        assert!(store
            .list_pending_historian_runs(None, 2_000)
            .unwrap()
            .is_empty());
        assert_eq!(
            store
                .claim_historian_run("run-1", "install-one", 2_000)
                .unwrap(),
            HistorianClaimOutcome::Refused(HistorianClaimRefusal::UnknownRun)
        );
    }

    #[test]
    fn a_run_can_only_be_queued_from_a_firing_session() {
        let dir = tempfile::tempdir().unwrap();
        let store = open_store(dir.path());
        let loaded = store.load("ses").unwrap();
        store
            .commit(
                "ses",
                loaded.row_version,
                &CoreState::default(),
                &ModuleMeta::default(),
            )
            .unwrap();
        let error = store
            .publish_pending_historian_run(&NewHistorianPendingRun {
                run_id: "run-1".to_string(),
                session_id: "ses".to_string(),
                project_path: "git:proj".to_string(),
                firing_seq: 1,
                chunk_fingerprint: "fp".to_string(),
                system_prompt: "sys".to_string(),
                user_prompt: "user".to_string(),
                model_chain: vec!["test/model".to_string()],
                await_budget_ms: AWAIT_BUDGET_MS,
                now_ms: 1_000,
            })
            .expect_err("an idle session has no run to queue");
        assert!(error.to_string().contains("is not firing"), "{error}");
        assert!(store
            .list_pending_historian_runs(None, 2_000)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn the_lease_is_the_await_budget_capped_at_the_ceiling() {
        assert_eq!(historian_lease_ms(60_000), 60_000);
        assert_eq!(
            historian_lease_ms(AWAIT_BUDGET_MS),
            HISTORIAN_LEASE_CEILING_MS,
            "the await budget outliving the ceiling is what leaves a run to re-claim"
        );
        assert_eq!(
            historian_lease_ms(0),
            1,
            "a zero lease would be instantly stale"
        );
    }
}
