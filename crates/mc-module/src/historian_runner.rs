//! Which thing runs the historian's LLM call.
//!
//! Everything else about a fold — trigger evaluation, chunk assembly, prompt
//! bytes, validation, discard-last, the publish CAS, marker scheduling and the
//! failure taxonomy — is the module's and does not move. The only part that is
//! pluggable is the completion itself: prompt in, text out.
//!
//! Two runners exist:
//!
//! - [`HistorianRunnerKind::Broca`] opens a route to the `broca` module and
//!   drives the run there. This is the path the module has always taken, and it
//!   stays the default: nothing about its requests, its retries or its
//!   published output changes because this seam exists.
//! - [`HistorianRunnerKind::Host`] queues the assembled run for a claimant
//!   outside the module and waits for it to report back. It exists so a user
//!   with no Broca can still fold, which is the whole point of the seam.

use std::fmt;

/// The configured completion route for historian runs.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum HistorianRunnerKind {
    /// Drive the completion through the `broca` module (the current behaviour).
    #[default]
    Broca,
    /// Queue the completion for a claimant outside the module.
    Host,
}

impl HistorianRunnerKind {
    pub fn as_str(self) -> &'static str {
        match self {
            HistorianRunnerKind::Broca => "broca",
            HistorianRunnerKind::Host => "host",
        }
    }

    /// Parse a configured value. Unknown and empty spellings return `None` so
    /// the caller can warn and keep the default rather than silently rerouting
    /// every completion on a typo.
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "broca" => Some(HistorianRunnerKind::Broca),
            "host" => Some(HistorianRunnerKind::Host),
            _ => None,
        }
    }

    /// Every accepted spelling, for config warnings and documentation.
    pub const ACCEPTED_VALUES: [&'static str; 2] = ["broca", "host"];
}

impl fmt::Display for HistorianRunnerKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_runner_is_broca() {
        assert_eq!(HistorianRunnerKind::default(), HistorianRunnerKind::Broca);
    }

    #[test]
    fn runner_values_round_trip_through_their_wire_spelling() {
        for kind in [HistorianRunnerKind::Broca, HistorianRunnerKind::Host] {
            assert_eq!(HistorianRunnerKind::parse(kind.as_str()), Some(kind));
        }
        assert_eq!(
            HistorianRunnerKind::parse("  HOST "),
            Some(HistorianRunnerKind::Host)
        );
    }

    #[test]
    fn an_unknown_runner_value_is_rejected_rather_than_guessed() {
        for value in ["", "llm-runner", "hosted", "brocaa"] {
            assert_eq!(HistorianRunnerKind::parse(value), None, "value {value:?}");
        }
    }
}
