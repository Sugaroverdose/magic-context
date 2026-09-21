//! Convert raw local token counts using fixed class ratios without changing the
//! tokenizer or persisted counts. Session usage samples do not affect these helpers.

/// Class ratios resolved for a model by the caller.
#[derive(Debug, Clone, Copy)]
pub struct DecisionCalibration {
    pub system_ratio: f64,
    pub tools_ratio: f64,
    pub prose_ratio: f64,
    /// Family-inherited measurements are seeded; only genuinely unknown models are not.
    pub seeded: bool,
    /// Fallback for unknown models: callers must supply at least the largest measured
    /// class ratio in the static table. Values below two are rejected.
    pub unknown_fit_ratio: f64,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct LocalMass {
    pub system: f64,
    pub tools: f64,
    pub prose: f64,
}

impl DecisionCalibration {
    /// Accumulate fractional provider mass, then ceil once at the decision boundary.
    /// Invalid inputs yield infinity, so a finite provider window cannot admit them.
    pub fn provider_mass(self, raw: LocalMass, fit: bool) -> f64 {
        if [raw.system, raw.tools, raw.prose]
            .into_iter()
            .any(|count| !count.is_finite() || count < 0.0)
            || [self.system_ratio, self.tools_ratio, self.prose_ratio]
                .into_iter()
                .any(|ratio| !ratio.is_finite() || ratio <= 0.0)
            || (fit
                && !self.seeded
                && (!self.unknown_fit_ratio.is_finite() || self.unknown_fit_ratio < 2.0))
        {
            return f64::INFINITY;
        }
        let total = if fit && !self.seeded {
            (raw.system + raw.tools + raw.prose) * self.unknown_fit_ratio
        } else {
            raw.system * self.system_ratio
                + raw.tools * self.tools_ratio
                + raw.prose * self.prose_ratio
        };
        if total.is_finite() {
            total.ceil()
        } else {
            f64::INFINITY
        }
    }
}

/// Round available real-token budgets down before comparison with raw local mass.
pub fn local_budget(provider_tokens: f64, ratio: f64) -> f64 {
    if !provider_tokens.is_finite() || provider_tokens <= 0.0 || !ratio.is_finite() || ratio <= 0.0
    {
        return 0.0;
    }
    (provider_tokens / ratio).floor()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        system_ratio: f64,
        tools_ratio: f64,
        prose_ratio: f64,
        raw_system: f64,
        raw_tools: f64,
        raw_prose: f64,
        provider_mass: f64,
        provider_budget: f64,
        local_budget: f64,
    }

    #[test]
    fn shares_independent_fable_arithmetic_with_typescript() {
        let fixture: Fixture = serde_json::from_str(include_str!(
            "../../../tests/fixtures/decision-calibration.json"
        ))
        .unwrap();
        let seed = DecisionCalibration {
            system_ratio: fixture.system_ratio,
            tools_ratio: fixture.tools_ratio,
            prose_ratio: fixture.prose_ratio,
            seeded: true,
            unknown_fit_ratio: 2.0,
        };
        assert_eq!(
            seed.provider_mass(
                LocalMass {
                    system: fixture.raw_system,
                    tools: fixture.raw_tools,
                    prose: fixture.raw_prose,
                },
                true
            ),
            fixture.provider_mass
        );
        assert_eq!(
            local_budget(fixture.provider_budget, seed.prose_ratio),
            fixture.local_budget
        );
    }

    #[test]
    fn unknown_fit_is_conservative_while_decisions_stay_neutral() {
        let seed = DecisionCalibration {
            system_ratio: 1.0,
            tools_ratio: 1.0,
            prose_ratio: 1.0,
            seeded: false,
            unknown_fit_ratio: 2.0,
        };
        let raw = LocalMass {
            prose: 1000.0,
            ..Default::default()
        };
        assert_eq!(seed.provider_mass(raw, false), 1000.0);
        assert_eq!(seed.provider_mass(raw, true), 2000.0);
        assert_eq!(
            seed.provider_mass(
                LocalMass {
                    prose: f64::NAN,
                    ..raw
                },
                true
            ),
            f64::INFINITY
        );
        assert_eq!(local_budget(100.0, 0.0), 0.0);
    }
}
