//! Registry for every cross-module route opened by `mc-module`.
//!
//! Runtime clients and the manifest both resolve through this registry so adding a route target
//! cannot silently leave the module's `consumes` declaration behind.

use subc_protocol::RouteTarget;

pub const DEFAULT_THALAMUS_MODULE_ID: &str = "thalamus";
pub const DEFAULT_RUNNER_MODULE_ID: &str = "broca";

/// Runtime selection for module routes. A hosted historian runner has no cross-module target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteTargetConfig {
    runner_module_id: Option<String>,
}

impl Default for RouteTargetConfig {
    fn default() -> Self {
        Self::runner_module(DEFAULT_RUNNER_MODULE_ID)
    }
}

impl RouteTargetConfig {
    pub fn runner_module(module_id: impl Into<String>) -> Self {
        Self {
            runner_module_id: Some(module_id.into()),
        }
    }

    /// Select the host-owned runner path. The module must not advertise Broca in this mode.
    pub fn host_runner() -> Self {
        Self {
            runner_module_id: None,
        }
    }

    pub fn runner_module_id(&self) -> Option<&str> {
        self.runner_module_id.as_deref()
    }

    pub(crate) fn target(&self, route: RegisteredRoute) -> Option<RouteTarget> {
        route
            .module_id(self)
            .map(|module_id| RouteTarget::ManagementSurface {
                module_id: module_id.to_string(),
            })
    }
}

/// Every route-opening purpose in this crate. Callers must select one of these instead of
/// constructing a `RouteTarget` directly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RegisteredRoute {
    SessionResolve,
    HistorianRunner,
}

impl RegisteredRoute {
    const ALL: [Self; 2] = [Self::SessionResolve, Self::HistorianRunner];

    fn module_id(self, config: &RouteTargetConfig) -> Option<&str> {
        match self {
            Self::SessionResolve => Some(DEFAULT_THALAMUS_MODULE_ID),
            Self::HistorianRunner => config.runner_module_id(),
        }
    }
}

/// Module ids this module may open a route to under the resolved runner configuration.
pub fn route_targets(config: &RouteTargetConfig) -> Vec<String> {
    let mut targets = Vec::new();
    for module_id in RegisteredRoute::ALL
        .iter()
        .filter_map(|route| route.module_id(config))
    {
        if !targets.iter().any(|target| target == module_id) {
            targets.push(module_id.to_string());
        }
    }
    targets
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use super::*;

    #[test]
    fn route_targets_follow_the_resolved_runner() {
        assert_eq!(
            route_targets(&RouteTargetConfig::default()),
            vec!["thalamus".to_string(), "broca".to_string()]
        );
        assert_eq!(
            route_targets(&RouteTargetConfig::runner_module("custom-runner")),
            vec!["thalamus".to_string(), "custom-runner".to_string()]
        );
        assert_eq!(
            route_targets(&RouteTargetConfig::host_runner()),
            vec!["thalamus".to_string()]
        );
    }

    #[test]
    fn every_registered_route_target_is_declared_consumed() {
        for config in [
            RouteTargetConfig::default(),
            RouteTargetConfig::runner_module("custom-runner"),
            RouteTargetConfig::host_runner(),
        ] {
            let consumed = route_targets(&config);
            for route in RegisteredRoute::ALL {
                let Some(target) = config.target(route) else {
                    continue;
                };
                let RouteTarget::ManagementSurface { module_id } = target else {
                    panic!("registered module routes must use the management surface");
                };
                assert!(
                    consumed.contains(&module_id),
                    "{route:?} target {module_id:?} is absent from route_targets()"
                );
            }
        }
    }

    #[test]
    fn route_open_constructions_are_confined_to_the_registry() {
        fn visit(path: &Path, offenders: &mut Vec<String>) {
            for entry in fs::read_dir(path).expect("read source directory") {
                let entry = entry.expect("read source entry");
                let path = entry.path();
                if path.is_dir() {
                    visit(&path, offenders);
                    continue;
                }
                if path.extension().and_then(|value| value.to_str()) != Some("rs")
                    || path.file_name().and_then(|value| value.to_str()) == Some("route_targets.rs")
                {
                    continue;
                }
                let source = fs::read_to_string(&path).expect("read Rust source");
                if source.contains("RouteTarget::") {
                    offenders.push(
                        path.strip_prefix(env!("CARGO_MANIFEST_DIR"))
                            .unwrap_or(&path)
                            .display()
                            .to_string(),
                    );
                }
            }
        }

        let mut offenders = Vec::new();
        visit(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
            &mut offenders,
        );
        assert!(
            offenders.is_empty(),
            "route targets must be registered before opening: {offenders:?}"
        );
    }
}
