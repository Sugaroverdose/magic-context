fn reasoning_clear_fixture() -> TransformRequest {
    fn message(mid: &str, ordinal: u64, role: &str, signed: bool) -> CkIngressMessage {
        let mut content = Vec::new();
        if signed {
            content.push(ck_wire::CkWireBlock::bare(ck_wire::CkKind::Reasoning {
                text: format!("thinking-{mid}"),
                signature: Some(format!("signature-{mid}")),
            }));
        }
        content.push(ck_wire::CkWireBlock::bare(ck_wire::CkKind::Text {
            text: format!("content-{mid}"),
        }));
        CkIngressMessage {
            mid: mid.to_string(),
            ordinal,
            ck: CkWireMessage::from_parts(
                role,
                content,
                None,
                ck_wire::ProviderExtras::new(),
                ck_wire::HarnessMeta {
                    harness_id: Some(mid.to_string()),
                    ..Default::default()
                },
            ),
        }
    }
    let mut multipart = message("multipart-user", 4, "user", false);
    for index in 0..12 {
        multipart
            .ck
            .content
            .push(ck_wire::CkWireBlock::bare(ck_wire::CkKind::Text {
                text: format!("Additional user text part {index}"),
            }));
    }
    let mut request = active_opencode_req(
        "reasoning-clear-decisions",
        "cfg0",
        vec![
            message("user", 1, "user", false),
            message("old", 2, "assistant", true),
            multipart,
        ],
    );
    request.provider_id = Some("anthropic".to_string());
    request.serve_native = true;
    request.clear_reasoning_age = 10;
    with_usage(request, 10_000, 100_000)
}

fn reasoning_clear_target(response: &TransformResponse) -> Vec<u8> {
    response
        .messages()
        .iter()
        .find(|message| message.meta.harness_id.as_deref() == Some("old"))
        .unwrap()
        .canonical_bytes()
        .to_vec()
}

fn reasoning_clear_native(
    result: &TransformWithProjection,
    request: &TransformRequest,
) -> Vec<Value> {
    crate::encode_full_native_messages(
        &result.response,
        request,
        &result.reasoning_clear_units,
        &result.tag_numbers,
        result.mutation_exempt_mid.as_deref(),
        result.lineage_anchor_mid.as_deref(),
        result.transition_consumed,
    )
}

fn reasoning_clear_native_target(
    result: &TransformWithProjection,
    request: &TransformRequest,
) -> Value {
    reasoning_clear_native(result, request)
        .into_iter()
        .find(|message| message["info"]["id"] == "old")
        .unwrap()
}

#[test]
fn reasoning_clear_exempt_at_cutoff_waits_for_bust_and_replays_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let db = store(dir.path());
    let mut request = reasoning_clear_fixture();
    let ctx = pctx("git:proj", dir.path().to_str().unwrap(), 0);
    transform_with_projection(&db, &request, &ctx).unwrap();
    request.render_config = "cfg1".to_string();
    let hard = transform_with_projection(&db, &request, &ctx).unwrap();
    assert_eq!(hard.response.action, "HARD");
    let original = reasoning_clear_target(&hard.response);
    let original_native = reasoning_clear_native_target(&hard, &request);
    assert!(String::from_utf8_lossy(&original).contains("thinking-old"));
    assert!(hard.reasoning_watermark >= hard.tag_numbers["old"]);
    drop(db);
    let db = store(dir.path());
    let unchanged = transform_with_projection(&db, &request, &ctx).unwrap();
    assert_eq!(unchanged.response.action, "SOFT+");
    assert_eq!(reasoning_clear_target(&unchanged.response), original);
    let mut newer = request.messages[1].clone();
    newer.mid = "new".to_string();
    newer.ordinal = 17;
    newer.ck.meta.harness_id = Some("new".to_string());
    request.messages.push(newer);
    let deferred = transform_with_projection(&db, &request, &ctx).unwrap();
    assert_eq!(deferred.response.action, "SOFT+");
    assert_eq!(deferred.reasoning_watermark, hard.reasoning_watermark);
    assert_eq!(
        reasoning_clear_target(&deferred.response),
        original,
        "DEFER must not first-clear reasoning merely because its exemption moved"
    );
    assert_eq!(
        reasoning_clear_native_target(&deferred, &request),
        original_native
    );
    assert!(deferred.response.first_divergence.is_none());
    request.render_config = "cfg2".to_string();
    let applied = transform_with_projection(&db, &request, &ctx).unwrap();
    assert_eq!(applied.response.action, "HARD");
    let cleared = reasoning_clear_target(&applied.response);
    let cleared_native = reasoning_clear_native_target(&applied, &request);
    assert!(!String::from_utf8_lossy(&cleared).contains("thinking-old"));
    assert_ne!(original_native, cleared_native);
    for _ in 0..2 {
        let replay = transform_with_projection(&db, &request, &ctx).unwrap();
        assert_eq!(replay.response.action, "SOFT+");
        assert_eq!(reasoning_clear_target(&replay.response), cleared);
        assert_eq!(
            reasoning_clear_native_target(&replay, &request),
            cleared_native
        );
        assert!(replay.response.first_divergence.is_none());
    }
}

#[test]
fn reasoning_clear_legacy_missing_fingerprint_holds_until_bust() {
    let mut request = reasoning_clear_fixture();
    let mut newer = request.messages[1].clone();
    newer.mid = "new".to_string();
    newer.ordinal = 17;
    newer.ck.meta.harness_id = Some("new".to_string());
    request.messages.push(newer);
    let core = CoreState::default();
    let meta = ModuleMeta {
        reasoning_cleared_through_tag: 5,
        ..Default::default()
    };
    let tags = BTreeMap::from([("old".to_string(), 2), ("new".to_string(), 16)]);
    let projection = ck_wire::project_messages(&request.messages).unwrap();
    assert!(new_reasoning_clear_units(
        &core,
        &meta,
        &request,
        &tags,
        false,
        None,
        ReasoningClearSnapshot {
            meta: &meta,
            row_version: None,
            projection: &projection
        }
    )
    .is_empty());
    let units = new_reasoning_clear_units(
        &core,
        &meta,
        &request,
        &tags,
        true,
        None,
        ReasoningClearSnapshot {
            meta: &meta,
            row_version: None,
            projection: &projection,
        },
    );
    assert_eq!(reasoning_clear_mids(&units), HashSet::from(["old"]));
}

/// OpenCode tool-loop shape on OpenAI Responses: each assistant step carries a reasoning
/// part whose encrypted payload lives in provider metadata, then a visible answer.
fn opencode_openai_removal_request(steps: usize, provider: &str, model: &str) -> TransformRequest {
    let mut native = vec![json!({"info":{"id":"user-0","role":"user"},"parts":[
        {"id":"user-0-t","type":"text","text":"do the work"}]})];
    for step in 0..steps {
        let id = format!("a{step}");
        native.push(json!({"info":{"id":id,"role":"assistant"},"parts":[
            {"id":format!("{id}-r"),"type":"reasoning","text":format!("thinking-{id}"),
             "metadata":{"openai":{"itemId":format!("rs_{id}"),"reasoningEncryptedContent":format!("ENC_{id}")}}},
            {"id":format!("{id}-t"),"type":"text","text":format!("answer-{id}")}]}));
    }
    native.push(json!({"info":{"id":"user-last","role":"user"},"parts":[
        {"id":"user-last-t","type":"text","text":"continue"}]}));
    let messages = crate::codec::decode_opencode(&native).messages;
    let mut request = active_opencode_req("reasoning-removal-openai", "cfg0", messages);
    request.native_messages = Some(native);
    request.provider_id = Some(provider.to_string());
    request.model_key = Some(format!("{provider}/{model}"));
    request.serve_native = true;
    request.clear_reasoning_age = 3;
    with_usage(request, 10_000, 100_000)
}

fn native_reasoning_parts(native: &[Value], mid: &str) -> usize {
    native
        .iter()
        .find(|message| message["info"]["id"] == mid)
        .and_then(|message| message["parts"].as_array())
        .map(|parts| parts.iter().filter(|part| part["type"] == "reasoning").count())
        .unwrap_or(0)
}

#[test]
fn opencode_non_anthropic_removes_old_reasoning_on_bust_and_replays_on_defer() {
    let dir = tempfile::tempdir().unwrap();
    let db = store(dir.path());
    let ctx = pctx("git:proj", dir.path().to_str().unwrap(), 0);
    // A short session first: nothing is old enough yet.
    let short = opencode_openai_removal_request(2, "openai", "gpt-6.1-sol");
    transform_with_projection(&db, &short, &ctx).unwrap();

    // The loop grows on defer passes; a defer pass never originates a removal.
    let mut request = opencode_openai_removal_request(6, "openai", "gpt-6.1-sol");
    let deferred = transform_with_projection(&db, &request, &ctx).unwrap();
    assert_eq!(deferred.response.action, "SOFT+");
    let deferred_native = reasoning_clear_native(&deferred, &request);
    // Defer passes never mint a removal unit.
    assert!(!db
        .load(&request.session_id)
        .unwrap()
        .core
        .frozen_units
        .iter()
        .any(|unit| unit.key.starts_with("strip:reasoning_age:")));
    let _ = deferred_native;

    request.render_config = "cfg1".to_string();
    let hard = transform_with_projection(&db, &request, &ctx).unwrap();
    assert_eq!(hard.response.action, "HARD");
    let hard_native = reasoning_clear_native(&hard, &request);
    // Tags: user-0=1, a0=2, a1=3, user-last=4, a2..a5=5..8. Cutoff 8-3=5.
    let minted: HashSet<String> = db
        .load(&request.session_id)
        .unwrap()
        .core
        .frozen_units
        .iter()
        .filter_map(|unit| unit.key.strip_prefix("strip:reasoning_age:").map(str::to_string))
        .collect();
    assert_eq!(
        minted,
        HashSet::from(["a0".to_string(), "a1".to_string(), "a2".to_string()])
    );
    let removed: Vec<_> = (0..6)
        .map(|step| format!("a{step}"))
        .filter(|mid| native_reasoning_parts(&hard_native, mid) == 0)
        .collect();
    assert!(!removed.is_empty(), "the bust must remove old reasoning");
    assert!(!removed.contains(&"a5".to_string()), "the newest assistant keeps its reasoning");
    assert_eq!(native_reasoning_parts(&hard_native, "a5"), 1);
    let wire = serde_json::to_string(&hard_native).unwrap();
    for mid in &removed {
        assert!(!wire.contains(&format!("ENC_{mid}")), "{mid} encrypted payload left the wire");
        assert!(wire.contains(&format!("answer-{mid}")), "{mid} answer must survive");
    }
    // No canonical-Anthropic empty-shell unit is used on this route.
    assert!(reasoning_clear_mids(&hard.reasoning_clear_units).is_empty());

    for _ in 0..2 {
        let replay = transform_with_projection(&db, &request, &ctx).unwrap();
        assert_eq!(replay.response.action, "SOFT+");
        assert_eq!(
            serde_json::to_string(&reasoning_clear_native(&replay, &request)).unwrap(),
            wire
        );
        assert!(replay.response.first_divergence.is_none());
    }
}

#[test]
fn opencode_canonical_anthropic_does_not_use_the_removal_lane() {
    let dir = tempfile::tempdir().unwrap();
    let db = store(dir.path());
    let mut request = opencode_openai_removal_request(6, "anthropic", "claude-sonnet-5");
    let ctx = pctx("git:proj", dir.path().to_str().unwrap(), 0);
    transform_with_projection(&db, &request, &ctx).unwrap();
    request.render_config = "cfg1".to_string();
    let hard = transform_with_projection(&db, &request, &ctx).unwrap();
    assert_eq!(hard.response.action, "HARD");
    let loaded = db.load(&request.session_id).unwrap();
    assert!(!loaded
        .core
        .frozen_units
        .iter()
        .any(|unit| unit.key.starts_with("strip:reasoning_age:")));
}

#[test]
fn opencode_removal_selects_nothing_on_prefix_bound_unresolved_or_openrouter_routes() {
    let mut request =
        opencode_openai_removal_request(6, "google-vertex-anthropic", "claude-opus-5-5@20260930");
    // a2 keeps only its reasoning, so removing it would leave no content.
    request.messages[3].ck.content.retain(is_reasoning_block);
    let tags: BTreeMap<String, u64> = request
        .messages
        .iter()
        .enumerate()
        .map(|(index, message)| (message.mid.clone(), index as u64 + 1))
        .collect();
    let none = HashSet::new();
    assert!(opencode_reasoning_removal_mids(&request, &tags, Some(6), &none).is_empty());
    request.provider_id = None;
    request.model_key = Some("openai/gpt-6.1-sol".to_string());
    assert!(opencode_reasoning_removal_mids(&request, &tags, Some(6), &none).is_empty());
    request.provider_id = Some("openrouter".to_string());
    request.model_key = Some("openrouter/anthropic/claude-haiku-4.5".to_string());
    assert!(opencode_reasoning_removal_mids(&request, &tags, Some(6), &none).is_empty());
    request.provider_id = Some("openai".to_string());
    request.model_key = Some("openai/gpt-6.1-sol".to_string());
    // An ineligible message (a2) does not stop the walk on unbound models.
    let unbound = opencode_reasoning_removal_mids(&request, &tags, Some(6), &none);
    assert_eq!(unbound, HashSet::from(["a0", "a1", "a3", "a4"]));
    assert!(is_prefix_bound_thinking_model(Some("amazon-bedrock/us.anthropic.claude-fable-5-1-v1:0")));
    assert!(is_prefix_bound_thinking_model(Some("anthropic/claude-sonnet-5-5")));
    assert!(!is_prefix_bound_thinking_model(Some("anthropic/claude-sonnet-5")));
    assert!(!is_prefix_bound_thinking_model(Some("anthropic/claude-sonnet-5-50")));
}
