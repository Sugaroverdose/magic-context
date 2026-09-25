//! The in-process half of the host runner: runs the module has queued for a
//! claimant and is still waiting on.
//!
//! The durable half lives in the store (`mc_historian_pending_run` plus the
//! session's own historian state) and survives restarts. This half does not, and
//! does not need to: it exists only so the firing task that queued a run can be
//! woken by the report that answers it, the same way the in-module producer path
//! is woken by its own subscribe stream. A report that arrives with no waiter is
//! refused rather than half-applied — the run it belonged to is already over.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::Notify;

use crate::historian_producer::ProducerOutput;

/// What a claimant reported for one run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostRunReport {
    /// The completion produced text. `length_capped` means the model stopped at
    /// its output ceiling, so the document may be cut mid-structure — the same
    /// signal the in-module producer reads off its own run terminal.
    Output(ProducerOutput),
    /// The completion did not happen. The code is the claimant's own vocabulary
    /// (`chain_exhausted`, `no_models`, …) and lands in the failure taxonomy the
    /// same way a producer error does.
    Failed { code: String, message: String },
}

#[derive(Debug)]
struct HostRunSlot {
    report: Option<HostRunReport>,
    ready: Arc<Notify>,
}

/// Why a report could not be handed to a waiter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostReportDeliveryError {
    /// No firing in this process is waiting for the named run. Either it was
    /// never queued here, or it already ended.
    NoWaiter,
    /// A report for this run has already been accepted. The module takes exactly
    /// one terminal report per claim; later duplicates are dropped rather than
    /// re-validated.
    AlreadyReported,
}

impl HostReportDeliveryError {
    pub fn as_wire_str(self) -> &'static str {
        match self {
            HostReportDeliveryError::NoWaiter => "no_waiter",
            HostReportDeliveryError::AlreadyReported => "already_reported",
        }
    }
}

#[derive(Debug, Default)]
pub struct HostRunLedger {
    slots: Mutex<HashMap<String, HostRunSlot>>,
}

/// Removes a run from the ledger when the firing task that registered it ends,
/// however it ends. Without this a firing that failed before its report arrived
/// would leave a waiter nobody can ever satisfy.
pub struct HostRunRegistration {
    ledger: Arc<HostRunLedger>,
    run_id: String,
    ready: Arc<Notify>,
}

impl HostRunLedger {
    pub fn new() -> Self {
        Self::default()
    }

    /// Start waiting for a report on `run_id`.
    pub fn register(self: &Arc<Self>, run_id: &str) -> HostRunRegistration {
        let ready = Arc::new(Notify::new());
        let mut slots = self.slots.lock().expect("host run ledger mutex");
        slots.insert(
            run_id.to_string(),
            HostRunSlot {
                report: None,
                ready: Arc::clone(&ready),
            },
        );
        HostRunRegistration {
            ledger: Arc::clone(self),
            run_id: run_id.to_string(),
            ready,
        }
    }

    /// Hand a claimant's report to whoever is waiting for it.
    pub fn deliver(
        &self,
        run_id: &str,
        report: HostRunReport,
    ) -> Result<(), HostReportDeliveryError> {
        let mut slots = self.slots.lock().expect("host run ledger mutex");
        let Some(slot) = slots.get_mut(run_id) else {
            return Err(HostReportDeliveryError::NoWaiter);
        };
        if slot.report.is_some() {
            return Err(HostReportDeliveryError::AlreadyReported);
        }
        slot.report = Some(report);
        slot.ready.notify_waiters();
        Ok(())
    }

    fn take(&self, run_id: &str) -> Option<HostRunReport> {
        let mut slots = self.slots.lock().expect("host run ledger mutex");
        slots.get_mut(run_id).and_then(|slot| slot.report.take())
    }

    fn forget(&self, run_id: &str) {
        let mut slots = self.slots.lock().expect("host run ledger mutex");
        slots.remove(run_id);
    }

    /// How many runs this process is waiting on. Diagnostics only.
    pub fn waiting_count(&self) -> usize {
        self.slots.lock().expect("host run ledger mutex").len()
    }
}

impl HostRunRegistration {
    /// Wait for the report, or give up at `budget`.
    ///
    /// The notify is subscribed BEFORE the stored report is checked, so a report
    /// that lands between the two is still seen by this waiter rather than
    /// waited past.
    pub async fn wait(&self, budget: std::time::Duration) -> Option<HostRunReport> {
        let deadline = tokio::time::Instant::now() + budget;
        loop {
            let notified = self.ready.notified();
            if let Some(report) = self.ledger.take(&self.run_id) {
                return Some(report);
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return self.ledger.take(&self.run_id);
            }
        }
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }
}

impl Drop for HostRunRegistration {
    fn drop(&mut self) {
        self.ledger.forget(&self.run_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn output(text: &str) -> HostRunReport {
        HostRunReport::Output(ProducerOutput {
            text: text.to_string(),
            length_capped: false,
            usage: None,
        })
    }

    #[tokio::test]
    async fn a_report_wakes_the_waiter_that_queued_the_run() {
        let ledger = Arc::new(HostRunLedger::new());
        let registration = ledger.register("run-1");
        let deliverer = Arc::clone(&ledger);
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            deliverer.deliver("run-1", output("<doc/>")).unwrap();
        });
        let report = registration
            .wait(std::time::Duration::from_secs(5))
            .await
            .expect("the queued run must receive its report");
        assert_eq!(report, output("<doc/>"));
    }

    #[test]
    fn a_report_for_a_run_nobody_queued_is_refused() {
        let ledger = Arc::new(HostRunLedger::new());
        assert_eq!(
            ledger.deliver("run-unknown", output("<doc/>")),
            Err(HostReportDeliveryError::NoWaiter)
        );
    }

    #[test]
    fn only_the_first_report_for_a_claim_is_accepted() {
        let ledger = Arc::new(HostRunLedger::new());
        let _registration = ledger.register("run-1");
        assert_eq!(ledger.deliver("run-1", output("<first/>")), Ok(()));
        assert_eq!(
            ledger.deliver("run-1", output("<second/>")),
            Err(HostReportDeliveryError::AlreadyReported)
        );
    }

    #[test]
    fn ending_a_firing_removes_its_waiter() {
        let ledger = Arc::new(HostRunLedger::new());
        {
            let _registration = ledger.register("run-1");
            assert_eq!(ledger.waiting_count(), 1);
        }
        assert_eq!(ledger.waiting_count(), 0);
        assert_eq!(
            ledger.deliver("run-1", output("<late/>")),
            Err(HostReportDeliveryError::NoWaiter)
        );
    }

    #[tokio::test]
    async fn a_waiter_that_runs_out_of_budget_reports_nothing() {
        let ledger = Arc::new(HostRunLedger::new());
        let registration = ledger.register("run-1");
        assert_eq!(
            registration
                .wait(std::time::Duration::from_millis(10))
                .await,
            None
        );
    }
}
