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

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SeedEntry {
    prefix: String,
    system_ratio: f64,
    tools_ratio: f64,
    #[serde(default = "neutral_ratio")]
    prose_ratio: f64,
}
fn neutral_ratio() -> f64 {
    1.0
}

fn seeds() -> &'static [SeedEntry] {
    static SEEDS: std::sync::OnceLock<Vec<SeedEntry>> = std::sync::OnceLock::new();
    SEEDS.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../packages/plugin/src/hooks/magic-context/tokenizer-calibration-seeds.json"
        ))
        .expect("compiled static calibration table")
    })
}

fn lineage(model: &str) -> Option<(String, Vec<u64>, String)> {
    let tokens: Vec<_> = model.split('-').collect();
    let numeric = |token: &str| {
        !token.is_empty()
            && token
                .split('.')
                .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
    };
    let at = tokens.iter().position(|token| numeric(token))?;
    if at == 0 {
        return None;
    }
    let mut end = at;
    let mut version = Vec::new();
    while end < tokens.len() && numeric(tokens[end]) {
        for part in tokens[end].split('.') {
            version.push(part.parse().ok()?);
        }
        end += 1;
    }
    Some((tokens[..at].join("-"), version, tokens[end..].join("-")))
}
fn version_order(a: &[u64], b: &[u64]) -> std::cmp::Ordering {
    for i in 0..a.len().max(b.len()) {
        let order = a.get(i).unwrap_or(&0).cmp(b.get(i).unwrap_or(&0));
        if order != std::cmp::Ordering::Equal {
            return order;
        }
    }
    std::cmp::Ordering::Equal
}

/// Identify a table seed versus same-family inheritance; session usage samples never affect this lookup.
pub fn seed_source(model_key: Option<&str>) -> &'static str {
    let key = model_key.unwrap_or("").to_lowercase();
    if DecisionCalibration::for_model(model_key).seeded
        && !seeds().iter().any(|s| key.starts_with(&s.prefix))
    {
        "family-fallback"
    } else {
        "seed"
    }
}

impl DecisionCalibration {
    /// Match the longest measured prefix, then the nearest version in the same
    /// provider/family/variant, preferring an older version. Shares the TS table.
    pub fn for_model(model_key: Option<&str>) -> Self {
        let key = model_key.unwrap_or("").to_lowercase();
        let table = seeds();
        let direct = table
            .iter()
            .filter(|entry| key.starts_with(&entry.prefix))
            .max_by_key(|entry| entry.prefix.len());
        let inherited = || {
            let (provider, model) = key.split_once('/')?;
            let (family, version, variant) = lineage(model)?;
            let mut below: Option<(&SeedEntry, Vec<u64>)> = None;
            let mut above: Option<(&SeedEntry, Vec<u64>)> = None;
            for entry in table {
                let Some(model) = entry.prefix.strip_prefix(&format!("{provider}/")) else {
                    continue;
                };
                let Some((f, v, kind)) = lineage(model) else {
                    continue;
                };
                if f != family || kind != variant {
                    continue;
                }
                match version_order(&v, &version) {
                    std::cmp::Ordering::Less
                        if below
                            .as_ref()
                            .is_none_or(|(_, old)| version_order(&v, old).is_gt()) =>
                    {
                        below = Some((entry, v))
                    }
                    std::cmp::Ordering::Greater
                        if above
                            .as_ref()
                            .is_none_or(|(_, old)| version_order(&v, old).is_lt()) =>
                    {
                        above = Some((entry, v))
                    }
                    _ => {}
                }
            }
            below.or(above).map(|(entry, _)| entry)
        };
        let selected = direct.or_else(inherited);
        Self {
            system_ratio: selected.map_or(1.0, |s| s.system_ratio),
            tools_ratio: selected.map_or(1.0, |s| s.tools_ratio),
            prose_ratio: selected.map_or(1.0, |s| s.prose_ratio),
            seeded: selected.is_some(),
            unknown_fit_ratio: table
                .iter()
                .flat_map(|s| [s.system_ratio, s.tools_ratio, s.prose_ratio])
                .fold(2.0, f64::max),
        }
    }
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
