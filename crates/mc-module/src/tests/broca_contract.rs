//! The contract a Broca-hosted session relies on before the transform is switched on
//! for it. `docs/architecture/broca-transform-contract.md` is the prose half; these
//! tests pin the parts a caller caches: the facade tool array it declares once per
//! session, and what the transform serves on the first and second send under the
//! `owned-broca` serializer profile.

use super::*;

/// The facade tools a Broca mason may declare. `transform` is a module tool too, but
/// only Broca's transform plane calls it; a model must never see it.
const BROCA_FACADE_TOOL_NAMES: [&str; 5] = [
    "ctx_reduce",
    "ctx_memory",
    "ctx_expand",
    "ctx_search",
    "ctx_note",
];

/// Set this variable to rewrite the golden files from the current module output.
const BLESS_ENV: &str = "MC_BLESS_BROCA_FACADE_GOLDENS";

fn golden_path(preset: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("testdata")
        .join(format!("broca-facade-tools-{preset}.json"))
}

async fn served_facade_tools(handler: &McHandler, preset: &str) -> Value {
    let response = call_dispatch_request(
        handler,
        json!({
            "kind": "manifest.get",
            "session_id": "ses",
            "preset": preset,
        }),
    )
    .await;
    assert_eq!(
        response["ok"],
        json!(true),
        "manifest.get failed: {response}"
    );
    assert_eq!(response["served_preset"], json!(preset));
    assert_eq!(response["preset_fallback"], json!(false));
    response["tools"].clone()
}

fn tool_names(tools: &Value) -> Vec<String> {
    tools
        .as_array()
        .expect("tools must be an array")
        .iter()
        .map(|tool| tool["name"].as_str().expect("tool name").to_string())
        .collect()
}

/// The served definitions are compared both as JSON values and as the exact pretty
/// bytes, so a reordered schema key fails here too: providers cache on bytes.
#[tokio::test(flavor = "current_thread")]
async fn broca_facade_tool_arrays_match_the_per_preset_goldens() {
    for preset in ["full", "light"] {
        let (handler, _store, _dir, _project) =
            handler_with_store(Arc::new(ProducerState::default()), default_test_config());
        let served = served_facade_tools(&handler, preset).await;
        let served_bytes = format!("{}\n", serde_json::to_string_pretty(&served).unwrap());
        let path = golden_path(preset);
        if std::env::var_os(BLESS_ENV).is_some() {
            std::fs::write(&path, &served_bytes).unwrap();
            continue;
        }
        let golden_bytes = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
        let golden: Value = serde_json::from_str(&golden_bytes).unwrap();
        assert_eq!(
            served,
            golden,
            "served {preset} facade tools drifted from {}; a changed tool array busts every \
             Broca session's cached prefix, so update the golden only on purpose (set {BLESS_ENV}=1)",
            path.display()
        );
        assert_eq!(
            served_bytes,
            golden_bytes,
            "served {preset} facade tool bytes drifted from {}",
            path.display()
        );
        assert_eq!(tool_names(&served), BROCA_FACADE_TOOL_NAMES);
    }
}

/// The array does not depend on anything a caller might vary between sessions except the
/// preset: `memory.enabled` does not hide `ctx_memory`, the dreamer-only `ctx_memory_list`
/// never appears, and the startup manifest carries the same full-preset definitions plus
/// the internal `transform` tool.
#[tokio::test(flavor = "current_thread")]
async fn broca_facade_tool_array_ignores_memory_config_and_matches_the_startup_manifest() {
    let full_golden: Value =
        serde_json::from_str(&std::fs::read_to_string(golden_path("full")).unwrap()).unwrap();
    let light_golden: Value =
        serde_json::from_str(&std::fs::read_to_string(golden_path("light")).unwrap()).unwrap();
    assert_eq!(tool_names(&full_golden), tool_names(&light_golden));
    assert_ne!(full_golden, light_golden, "light must differ only in prose");

    let mut memory_off = default_test_config();
    memory_off.memory_enabled = false;
    let (handler, _store, _dir, _project) =
        handler_with_store(Arc::new(ProducerState::default()), memory_off);
    for (preset, golden) in [("full", &full_golden), ("light", &light_golden)] {
        let served = served_facade_tools(&handler, preset).await;
        assert_eq!(
            &served, golden,
            "memory.enabled=false changed the {preset} array"
        );
    }

    let startup = serde_json::to_value(manifest(DEFAULT_MODULE_ID)).unwrap();
    let startup_tools =
        find_tools_array(&startup["provides"]).expect("startup manifest declares a tool provider");
    let startup_names = startup_tools
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert!(startup_names.contains(&"transform"));
    assert!(!startup_names.contains(&"ctx_memory_list"));
    let startup_facades = startup_tools
        .iter()
        .filter(|tool| tool["name"] != json!("transform"))
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(Value::Array(startup_facades), full_golden);
}

/// Find the first `tools` array under a serialized manifest value, whatever the role
/// enum's serde tagging looks like.
fn find_tools_array(value: &Value) -> Option<&Vec<Value>> {
    match value {
        Value::Object(fields) => fields
            .get("tools")
            .and_then(Value::as_array)
            .or_else(|| fields.values().find_map(find_tools_array)),
        Value::Array(items) => items.iter().find_map(find_tools_array),
        _ => None,
    }
}

/// Build one request exactly as Broca's transform plane sends it: the `owned-broca`
/// profile, the profile folded into `render_config`, and the fields the module does not
/// read today (`agent_drop_ids`, `cache_ttl_ms`) left in so the test sends the real shape.
fn broca_transform_request(messages: &[CkIngressMessage], input_tokens: u64) -> Value {
    json!({
        "kind": "transform",
        "v": 1,
        "serializer_profile": "owned-broca",
        "session_id": "ses",
        "render_config": "owned-broca\u{241f}rc-contract",
        "messages": messages,
        "usage": {
            "current_total_input_tokens": input_tokens,
            "context_limit_tokens": 200_000,
        },
        "cache_ttl_ms": 300_000,
        "agent_drop_ids": [],
    })
}

fn served_messages(response: &Value) -> Vec<Value> {
    assert_eq!(
        response["status"],
        json!("ok"),
        "transform failed: {response}"
    );
    response["ck_messages"].as_array().unwrap().clone()
}

fn is_synthetic_user(message: &Value) -> bool {
    message["role"] == json!("user") && message["meta"]["synthetic"] == json!(true)
}

fn text_of(message: &Value) -> String {
    message["content"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|block| block["kind"]["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

/// Two sends of a small Broca session. What this pins, send by send:
/// - send 1 is the session's first materialization (HARD): two synthetic user rows, m[0]
///   and m[1], are placed AHEAD of the caller's system message, and the system message
///   itself comes back byte-for-byte unchanged (no guidance, date or tags added to it);
/// - send 2 is a replay (the module reports it as `SOFT+`): the whole send-1 output is
///   served again byte-identical as the prefix, with only the new messages appended;
/// - `owned-broca` never gets the tag overlay, so no `§N§` tag appears on any row on
///   either send;
/// - the facade tool array read before send 1 and after send 2 is identical.
#[tokio::test(flavor = "current_thread")]
async fn owned_broca_two_sends_keep_system_and_tools_stable_and_never_tag() {
    let (handler, _store, _dir, project) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    // A project doc gives m[0] (the first synthetic history row) content on the very
    // first send, as a real project with ARCHITECTURE.md or active memories would.
    std::fs::write(
        project.join("ARCHITECTURE.md"),
        "# Architecture\nBROCA-CONTRACT-DOC\n",
    )
    .unwrap();

    let tools_before = served_facade_tools(&handler, "full").await;

    let system = ck_with_role("sys", 0, "system", "Pinned mason system prompt.");
    let send_1_input = vec![system.clone(), ck("u1", 1, "First user turn.")];
    let first = call_transform_request(&handler, broca_transform_request(&send_1_input, 0)).await;
    let send_1 = served_messages(&first);
    assert_eq!(first["decision"], json!("HARD"));
    assert_eq!(first["surface_state"], json!("inactive"));

    let mut send_2_input = send_1_input.clone();
    send_2_input.push(ck_with_role("a1", 2, "assistant", "First answer."));
    send_2_input.push(ck("u2", 3, "Second user turn."));
    let second =
        call_transform_request(&handler, broca_transform_request(&send_2_input, 1_200)).await;
    let send_2 = served_messages(&second);
    assert_eq!(second["decision"], json!("SOFT+"));
    assert_eq!(second["surface_state"], json!("inactive"));

    let tools_after = served_facade_tools(&handler, "full").await;
    assert_eq!(
        tools_after, tools_before,
        "tool array changed between sends"
    );

    let expected_system = serde_json::to_value(&system.ck).unwrap();
    for (send, served) in [("send 1", &send_1), ("send 2", &send_2)] {
        // Layout: m[0], m[1], then the caller's array from its system message on.
        assert!(is_synthetic_user(&served[0]), "{send}: m[0] missing");
        assert!(is_synthetic_user(&served[1]), "{send}: m[1] missing");
        assert!(text_of(&served[0]).contains("BROCA-CONTRACT-DOC"));
        assert!(text_of(&served[0]).contains("<session-history>"));
        assert!(text_of(&served[1]).starts_with("<session-history-since>"));
        let systems = served
            .iter()
            .enumerate()
            .filter(|(_, message)| message["role"] == json!("system"))
            .collect::<Vec<_>>();
        assert_eq!(systems.len(), 1, "{send}: exactly one system message");
        assert_eq!(systems[0].0, 2, "{send}: system sits after m[0] and m[1]");
        assert_eq!(
            systems[0].1, &expected_system,
            "{send}: system message altered"
        );
        for message in served.iter() {
            assert!(
                !text_of(message).contains('§'),
                "{send}: a tag reached an owned-broca row: {message}"
            );
        }
        assert_eq!(served.len(), 2 + if send == "send 1" { 2 } else { 4 });
    }
    assert_eq!(
        send_2[..send_1.len()],
        send_1[..],
        "send 2 must replay the send-1 output byte-identical as its prefix"
    );
    assert_eq!(
        send_2[send_1.len()..]
            .iter()
            .map(text_of)
            .collect::<Vec<_>>(),
        ["First answer.", "Second user turn."]
    );

    // No tag appeared because the profile gate turns tagging off, not because this small
    // fixture had nothing to tag: even a sender that sets `tool_present` (it advertises
    // ctx_reduce) gets no tags under `owned-broca`.
    assert!(!tagging_surface_active(
        Some(SerializerProfile::OwnedBroca),
        true
    ));
    assert!(!cc_u1_active(Some(SerializerProfile::OwnedBroca), true));
}
