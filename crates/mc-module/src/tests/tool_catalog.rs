//! `tool.catalog` and `role.describe` against the design's pinned payloads.
//!
//! `docs/designs/mc-tool-catalog-v1/` holds the exact bytes the module must serve
//! for each example request under the example config, and
//! `testdata/tool-catalog-guidance-matrix.json` the digest of every guidance text
//! for every combination of config inputs. Both are written by the design's
//! generator from the same shared definition the module serves from, so these
//! tests hold the generator's TypeScript renderer and this module's Rust one to
//! the same bytes.

use std::collections::BTreeMap;
use std::path::PathBuf;

use cortexkit_role_tool_provider::check_capability_tag;

use super::*;
use crate::tool_catalog::{self, CatalogConfig, CatalogError, Surface, TextFlags};

fn examples_dir() -> PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/designs/mc-tool-catalog-v1")
}

/// The example config, as `config.json` records it.
fn example_config_json() -> Value {
    let text = std::fs::read_to_string(examples_dir().join("config.json")).unwrap();
    serde_json::from_str(&text).unwrap()
}

/// The example config as the catalog resolves it. The examples carry no
/// guidance override, so the override's digest must be absent.
fn example_catalog_config() -> CatalogConfig {
    let config = &example_config_json()["config"];
    assert!(config["guidance_override_sha256"].is_null());
    let surface = |value: &Value| match value.as_str() {
        Some("full") => Surface::Full,
        Some("light") => Surface::Light,
        other => panic!("not a surface: {other:?}"),
    };
    CatalogConfig {
        compaction_enabled: config["compaction_enabled"].as_bool().unwrap(),
        memory_enabled: config["memory_enabled"].as_bool().unwrap(),
        dreamer_runnable: config["dreamer_runnable"].as_bool().unwrap(),
        temporal_awareness: config["temporal_awareness"].as_bool().unwrap(),
        caveman_text_compression: config["caveman_text_compression"].as_bool().unwrap(),
        language: config["language"].as_str().map(str::to_string),
        surface_default: surface(&config["prompt_surface"]["default"]),
        surface_models: config["prompt_surface"]["models"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(key, value)| (key.clone(), surface(value)))
            .collect(),
        guidance_override: None,
        tool_descriptions: serde_json::from_value(config["tool_descriptions"].clone()).unwrap(),
        disabled_tools: serde_json::from_value(config["disabled_tools"].clone()).unwrap(),
    }
}

/// The same example config as the module holds it after reading the user and
/// project tiers (`config::merge_tiers_with_warnings` is tested on its own).
fn example_module_config() -> McModuleConfig {
    let mut config = default_test_config();
    config.catalog = crate::config::CatalogConfigInputs {
        prompt_surface_default: Some("full".to_string()),
        prompt_surface_models: BTreeMap::from([(
            "anthropic/claude-haiku-4-5".to_string(),
            "light".to_string(),
        )]),
        tool_descriptions: BTreeMap::new(),
        dreamer_runnable: true,
    };
    config.memory_enabled = true;
    config.compaction_enabled = true;
    config.temporal_awareness = true;
    config.caveman.enabled = false;
    config.language = None;
    config.prompt_surface_guidance_override = None;
    config
}

/// Every example: its name, request and pinned answer bytes.
fn examples() -> Vec<(String, Value, Vec<u8>)> {
    let mut names: Vec<String> = std::fs::read_dir(examples_dir())
        .unwrap()
        .filter_map(|entry| {
            let name = entry.unwrap().file_name().into_string().unwrap();
            name.strip_suffix(".request.json").map(str::to_string)
        })
        .collect();
    names.sort();
    names
        .into_iter()
        .map(|name| {
            let dir = examples_dir();
            let request: Value = serde_json::from_str(
                &std::fs::read_to_string(dir.join(format!("{name}.request.json"))).unwrap(),
            )
            .unwrap();
            let answer = std::fs::read(dir.join(format!("{name}.answer.jcs"))).unwrap();
            (name, request, answer)
        })
        .collect()
}

#[test]
fn every_example_request_gets_exactly_the_pinned_answer_bytes() {
    let config = example_catalog_config();
    let examples = examples();
    assert_eq!(examples.len(), 8, "the design pins eight examples");
    for (name, request, expected) in examples {
        let actual = tool_catalog::catalog_answer_bytes(&request, &config)
            .unwrap_or_else(|error| panic!("{name}: {error:?}"));
        assert!(
            actual == expected,
            "{name}: served\n{}\npinned\n{}",
            String::from_utf8_lossy(&actual),
            String::from_utf8_lossy(&expected)
        );
    }
}

#[test]
fn the_example_settings_resolve_to_the_example_config_member_for_member() {
    assert_eq!(
        CatalogConfig::from_module_config(&example_module_config()),
        example_catalog_config()
    );
}

#[test]
fn text_revision_is_the_one_config_json_records() {
    assert_eq!(
        json!(tool_catalog::text_revision().unwrap()),
        example_config_json()["text_revision"]
    );
}

#[test]
fn every_guidance_text_matches_the_generators_matrix() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("testdata/tool-catalog-guidance-matrix.json");
    let matrix: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let override_sample = matrix["override_sample"].as_str().unwrap().to_string();
    let cases = matrix["cases"].as_array().unwrap();
    // Five variants, both surfaces, sixteen flag combinations, two languages.
    assert_eq!(cases.len(), 5 * 2 * 16 * 2);
    for case in cases {
        let directive = case["language"]
            .as_str()
            .and_then(crate::primary_language_directive);
        let flags = TextFlags {
            memory: case["memory"].as_bool().unwrap(),
            dreamer: case["dreamer"].as_bool().unwrap(),
            temporal: case["temporal"].as_bool().unwrap(),
            caveman: case["caveman"].as_bool().unwrap(),
            language: directive.is_some(),
        };
        let mut values = BTreeMap::new();
        values.insert("language_directive", directive.unwrap_or_default());
        let name = if case["override"].as_bool().unwrap() {
            values.insert("override", override_sample.clone());
            "override".to_string()
        } else {
            format!(
                "{}/{}",
                case["variant"].as_str().unwrap(),
                case["surface"].as_str().unwrap()
            )
        };
        let text = tool_catalog::render_text(&name, &flags, &values).unwrap();
        assert_eq!(
            (text.len() as u64, sha256_hex(text.as_bytes())),
            (
                case["bytes"].as_u64().unwrap(),
                case["sha256"].as_str().unwrap().to_string()
            ),
            "{case}"
        );
    }
}

#[test]
fn the_guidance_get_assets_are_renderings_of_the_shared_definition() {
    // guidance.get still serves these files; the catalog serves the definition.
    // Holding them equal keeps the two surfaces from drifting apart.
    let flags = TextFlags {
        memory: true,
        dreamer: true,
        temporal: true,
        caveman: false,
        language: false,
    };
    let values = BTreeMap::from([("language_directive", String::new())]);
    for (asset, text) in [
        (
            crate::prompt_surface::GUIDANCE_FULL_PRIMARY,
            "primary/reduce/full",
        ),
        (
            crate::prompt_surface::GUIDANCE_FULL_NO_REDUCE,
            "primary/no_reduce/full",
        ),
        (
            include_str!("../../assets/guidance_light_primary.txt"),
            "primary/reduce/light",
        ),
        (
            include_str!("../../assets/guidance_light_no_reduce.txt"),
            "primary/no_reduce/light",
        ),
    ] {
        assert_eq!(
            tool_catalog::render_text(text, &flags, &values).unwrap(),
            asset,
            "{text}"
        );
    }
}

#[test]
fn every_capability_tag_passes_the_roles_check() {
    let mut tags: Vec<String> = tool_catalog::definition()
        .tools
        .iter()
        .flat_map(|tool| tool.capabilities.clone())
        .collect();
    fn collect(value: &Value, tags: &mut Vec<String>) {
        match value {
            Value::Array(items) => items.iter().for_each(|item| collect(item, tags)),
            Value::Object(map) => {
                for (key, item) in map {
                    match (key.as_str(), item) {
                        ("capabilities", Value::Array(found)) => {
                            tags.extend(found.iter().filter_map(Value::as_str).map(str::to_string))
                        }
                        _ => collect(item, tags),
                    }
                }
            }
            _ => {}
        }
    }
    for (_, request, answer) in examples() {
        collect(&request, &mut tags);
        collect(&serde_json::from_slice(&answer).unwrap(), &mut tags);
    }
    tags.sort();
    tags.dedup();
    assert_eq!(tags.len(), 14, "{tags:?}");
    for tag in &tags {
        assert_eq!(check_capability_tag(tag), Ok(()), "{tag}");
    }
}

#[test]
fn ctx_reduce_keeps_its_frozen_schema_at_both_surfaces() {
    let definition = tool_catalog::definition();
    let reduce = definition
        .tools
        .iter()
        .find(|tool| tool.name == "ctx_reduce")
        .unwrap();
    for surface in [Surface::Full, Surface::Light] {
        let schema = tool_catalog::input_schema(reduce, surface).unwrap();
        assert_eq!(
            cortexkit_role_tool_provider::catalog::schema_digest(&schema).unwrap(),
            tool_catalog::FROZEN_CTX_REDUCE_SCHEMA_DIGEST
        );
        assert_eq!(
            cortexkit_role_tool_provider::catalog::check_flat_schema(&schema),
            Ok(())
        );
    }
}

#[test]
fn model_keys_are_searched_in_the_plugins_order() {
    assert_eq!(
        tool_catalog::model_key_candidates("anthropic/claude-haiku-4-5"),
        [
            "anthropic/claude-haiku-4-5",
            "claude-haiku-4-5",
            "anthropic/claude-haiku-4",
            "claude-haiku-4",
            "anthropic/claude-haiku",
            "claude-haiku",
            "anthropic/claude",
            "claude",
            "anthropic/*",
        ]
    );
    // A Pi-native provider is searched canonical-first, then as sent, then in
    // OMP's spelling, which here is the same as Pi's.
    assert_eq!(
        tool_catalog::model_key_candidates("openai-codex/gpt-5"),
        [
            "openai/gpt-5",
            "openai-codex/gpt-5",
            "gpt-5",
            "openai/gpt",
            "openai-codex/gpt",
            "gpt",
            "openai/*",
            "openai-codex/*",
        ]
    );
    for malformed in ["no-slash", "/model", "provider/"] {
        assert!(tool_catalog::model_key_candidates(malformed).is_empty());
    }
}

#[test]
fn refusals_name_the_offending_field() {
    let config = example_catalog_config();
    for (arguments, field) in [
        (json!({"params": {}, "preset": "head"}), "preset"),
        (
            json!({"params": {}, "preset": "primary", "system_text": {"preset": "subagent", "params": {}}}),
            "system_text.preset",
        ),
        (json!({"params": {"verbosity": "high"}}), "params.verbosity"),
        (json!({"params": {"scope": "everything"}}), "params.scope"),
        (
            json!({"params": {"exclude": ["ctx_memory_list"]}}),
            "params.exclude",
        ),
        (
            json!({"params": {}, "system_text": {"preset": "primary", "params": {"surface": "tiny"}}}),
            "system_text.params.surface",
        ),
        (
            // tools-only never serves ctx_reduce, so a composition listing it
            // describes a session this answer cannot serve.
            json!({"params": {}, "preset": "tools-only", "composition": {"providers": [{
                "provider": "magic-context",
                "tools": [{"name": "ctx_expand"}, {"name": "ctx_memory"}, {"name": "ctx_note"},
                          {"name": "ctx_reduce"}, {"name": "ctx_search"}],
            }]}}),
            "composition",
        ),
        (
            // No shipped text describes a session without ctx_note.
            json!({"params": {"scope": "read"}, "system_text": {"preset": "primary", "params": {}}}),
            "system_text",
        ),
        (json!("not an object"), "arguments"),
    ] {
        match tool_catalog::catalog_answer(&arguments, &config) {
            Err(CatalogError::Invalid { field: actual, .. }) => {
                assert_eq!(actual, field, "{arguments}")
            }
            other => panic!("{arguments}: expected a refusal naming {field}, got {other:?}"),
        }
    }
}

#[test]
fn a_user_override_replaces_the_primary_text_only() {
    let mut config = example_catalog_config();
    config.guidance_override = Some("My own section.".to_string());
    let text_for = |preset: &str, config: &CatalogConfig| {
        let answer = tool_catalog::catalog_answer(
            &json!({"params": {}, "preset": preset, "system_text": {"preset": preset, "params": {}}}),
            config,
        )
        .unwrap();
        answer["system_text"]["text"].as_str().unwrap().to_string()
    };
    let primary = text_for("primary", &config);
    assert!(primary.starts_with("My own section."), "{primary}");
    // The config-driven clauses (here the temporal-marker line) still follow
    // the user's section.
    assert!(primary.contains("<!-- +Xm -->"), "{primary}");
    // The tools-only and subagent texts describe what Magic Context does in
    // those sessions; a primary override never stands in for them.
    let plain = example_catalog_config();
    assert_eq!(
        text_for("tools-only", &config),
        text_for("tools-only", &plain)
    );
    assert_eq!(text_for("subagent", &config), text_for("subagent", &plain));
    // The override changes only answers that carry a text item: without one
    // there is no preflight_digest, so the catalog digest stays the same.
    let digest = |config: &CatalogConfig| {
        tool_catalog::catalog_answer(&json!({"params": {}}), config).unwrap()["catalog_digest"]
            .clone()
    };
    assert_eq!(
        digest(&config),
        digest(&plain),
        "no text item, so no preflight digest"
    );
}

/// The handler a dispatch test drives: the example config, bound on channel 7.
fn example_handler() -> (McHandler, Arc<McStore>, tempfile::TempDir, PathBuf) {
    let (handler, store, dir, project) =
        handler_with_store(Arc::new(ProducerState::default()), example_module_config());
    handler.bind_route(
        7,
        SessionBinding {
            config: example_module_config(),
            ..binding(project.to_str().unwrap(), "ses")
        },
    );
    (handler, store, dir, project)
}

#[tokio::test(flavor = "current_thread")]
async fn tool_catalog_over_the_route_serves_the_pinned_bytes() {
    let (handler, _store, _dir, _project) = example_handler();
    for (name, request, expected) in examples() {
        let outcome = handler
            .dispatch_value(7, json!({"name": "tool.catalog", "arguments": request}))
            .await;
        match outcome {
            HandlerOutcome::Response(bytes) => assert!(bytes == expected, "{name}"),
            other => panic!("{name}: {other:?}"),
        }
    }
}

#[tokio::test(flavor = "current_thread")]
async fn an_undefined_preset_is_refused_with_the_roles_error_body() {
    let (handler, _store, _dir, _project) = example_handler();
    let outcome = handler
        .dispatch_value(
            7,
            json!({"name": "tool.catalog", "arguments": {"params": {}, "preset": "head"}}),
        )
        .await;
    match outcome {
        HandlerOutcome::ErrorWithDetail { code, detail, .. } => {
            assert_eq!(code, "invalid_request");
            assert_eq!(detail, json!({"field": "preset"}));
        }
        other => panic!("{other:?}"),
    }
}

#[tokio::test(flavor = "current_thread")]
async fn role_describe_lists_the_required_ops_and_no_tools() {
    let (handler, _store, _dir, _project) = example_handler();
    let first = handler
        .dispatch_value(7, json!({"name": "role.describe", "arguments": {}}))
        .await;
    let HandlerOutcome::Response(bytes) = first else {
        panic!("{first:?}");
    };
    let answer: Value = serde_json::from_slice(&bytes).unwrap();
    let describe = cortexkit_role_tool_provider::describe::check_describe(&answer).unwrap();
    let major = describe
        .major(cortexkit_role_tool_provider::PROVIDES)
        .unwrap();
    assert!(!major.holds_calls());
    assert_eq!(describe.implementation_version, crate::version_line());
}

#[tokio::test(flavor = "current_thread")]
async fn only_a_route_that_declared_the_role_gets_unknown_tool() {
    let (handler, _store, _dir, _project) = example_handler();
    let unserved = json!({"name": "not_a_tool", "arguments": {}});
    // A legacy route keeps the error code it has always had.
    assert_eq!(
        error_code(handler.dispatch_value(7, unserved.clone()).await),
        "facade_envelope_not_supported"
    );
    handler.record_route_role_versions(
        7,
        Some(&BTreeMap::from([(
            "tool-provider".to_string(),
            "v1".to_string(),
        )])),
    );
    match handler.dispatch_value(7, unserved.clone()).await {
        HandlerOutcome::ErrorWithDetail { code, detail, .. } => {
            assert_eq!(code, "unknown_tool");
            assert_eq!(detail, json!({"tool": "not_a_tool"}));
        }
        other => panic!("{other:?}"),
    }
    // A rebind without the tool-provider/v1 declaration drops the role's codes.
    handler.record_route_role_versions(7, None);
    assert_eq!(
        error_code(handler.dispatch_value(7, unserved).await),
        "facade_envelope_not_supported"
    );
}
