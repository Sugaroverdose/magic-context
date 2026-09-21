//! Which side runs the historian's model call.
//!
//! Everything else about a fold — trigger evaluation, chunk assembly, prompt
//! bytes, validation, discard-last, the publish CAS, marker scheduling and the
//! failure taxonomy — belongs to this module and is identical under both
//! runners. The only pluggable part is the completion itself: prompt in, text
//! out.
//!
//! - [`HistorianRunnerKind::Broca`] opens a route to the `broca` module and
//!   drives the run there. It is the default, and its requests, retries and
//!   published output are the same as they were before a second runner existed.
//! - [`HistorianRunnerKind::Host`] queues the assembled run for a claimant
//!   outside the module and waits for it to report back. It exists so a project
//!   with no Broca module registered can still fold.

use std::fmt;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum HistorianRunnerKind {
    #[default]
    Broca,
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

    /// Named so a config warning can list what the user could have written.
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
