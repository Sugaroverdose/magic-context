use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use regex::Regex;
use rusqlite::{Connection, OpenFlags};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

const DB_SHA256: &str = "f589668287f41abaeb2a6526ee6d6f9d162e7ed80b1650f1ca5ec0a45984b8c0";
const CAPTURE_SHA256: &str = "766c26e1fab1129e0866e275c22d79e111a4382140f4334095279c46f26f526b";
const INDEX_SHA256: &str = "afaa461a4c3b1c0f7b3db00f40a268881ad35670b7c21065ee6c738e7050c461";
const DIGEST_PLACEHOLDER: &str = "<computed-by-slice-0>";
const PROBES: [(u64, &str); 3] = [
    (
        1824,
        "Your parsed disk assertions are independently verified: setup intact",
    ),
    (1864, "the archived project must still be findable by name"),
    (
        1927,
        "Take the real follow-up note1274: audit persistence-related test assertions in this repo",
    ),
];

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("d5-specimen")
}

fn parse_json(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap_or_else(|error| {
        panic!("read {}: {error}", path.display());
    }))
    .unwrap_or_else(|error| panic!("parse {}: {error}", path.display()))
}

fn object(value: &Value) -> &Map<String, Value> {
    value.as_object().expect("expected JSON object")
}

fn array(value: &Value) -> &[Value] {
    value.as_array().expect("expected JSON array")
}

fn text(value: &Value) -> &str {
    value.as_str().expect("expected JSON string")
}

fn number(value: &Value) -> u64 {
    value.as_u64().expect("expected nonnegative JSON integer")
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn decode_base64(encoded: &str) -> Vec<u8> {
    fn sextet(byte: u8) -> Option<u8> {
        match byte {
            b'A'..=b'Z' => Some(byte - b'A'),
            b'a'..=b'z' => Some(byte - b'a' + 26),
            b'0'..=b'9' => Some(byte - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }

    let input = encoded.as_bytes();
    assert_eq!(
        input.len() % 4,
        0,
        "base64 length must be divisible by four"
    );
    let mut output = Vec::with_capacity(input.len() / 4 * 3);
    for chunk in input.chunks_exact(4) {
        let a = sextet(chunk[0]).expect("base64 character");
        let b = sextet(chunk[1]).expect("base64 character");
        let c = if chunk[2] == b'=' {
            0
        } else {
            sextet(chunk[2]).expect("base64 character")
        };
        let d = if chunk[3] == b'=' {
            0
        } else {
            sextet(chunk[3]).expect("base64 character")
        };
        output.push((a << 2) | (b >> 4));
        if chunk[2] != b'=' {
            output.push((b << 4) | (c >> 2));
        }
        if chunk[3] != b'=' {
            output.push((c << 6) | d);
        }
    }
    output
}

fn stand_in(ordinal: u64, block_index: u64, length: usize, namespace: &str) -> Vec<u8> {
    let marker = format!("[sanitized:{namespace}:{ordinal}:{block_index}:{length}]").into_bytes();
    marker.iter().copied().cycle().take(length).collect()
}

fn identity_tuple(value: &Value) -> (String, u64, u64) {
    let value = object(value);
    (
        text(&value["mid"]).to_owned(),
        number(&value["index"]),
        number(&value["ordinal"]),
    )
}

#[test]
fn d5_fixture_index_pins_every_sibling_and_scans_for_secrets() {
    let root = fixture_dir();
    let index_bytes = fs::read(root.join("fixture-index-v1.json")).expect("read fixture index");
    assert_eq!(
        sha256_hex(&index_bytes),
        INDEX_SHA256,
        "fixture index drift"
    );
    let index: Value = serde_json::from_slice(&index_bytes).expect("parse fixture index");
    let index = object(&index);
    assert_eq!(text(&index["readiness"]), "scaffold");
    assert_eq!(text(&index["source_db_sha256"]), DB_SHA256);
    assert_eq!(text(&index["capture_13610_sha256"]), CAPTURE_SHA256);
    // The gateway owner's private snapshots are pinned per artifact, never as one
    // ambiguous "snapshot" hash; the capture hash must agree with ours.
    let gateway = object(&index["gateway_private_evidence"]);
    assert_eq!(
        text(&object(&gateway["13610-req-body"])["sha256"]),
        CAPTURE_SHA256
    );
    for artifact in [
        "mc_cache_state.json",
        "mc_compartments.json",
        "mc_tags.json",
    ] {
        assert_eq!(
            text(&object(&gateway[artifact])["sha256"]).len(),
            64,
            "{artifact}"
        );
    }

    let indexed_names = array(&index["files"])
        .iter()
        .map(|entry| text(&object(entry)["path"]).to_owned())
        .collect::<BTreeSet<_>>();
    let actual_names = fs::read_dir(&root)
        .expect("read fixture directory")
        .map(|entry| entry.expect("directory entry").file_name())
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| name != "fixture-index-v1.json")
        .collect::<BTreeSet<_>>();
    assert_eq!(
        indexed_names, actual_names,
        "index must cover every sibling file"
    );

    let email = Regex::new(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
        .expect("compile email scanner");
    let forbidden = ["~/", "/Users/", "sk-", "ghp_", "Bearer ", "ufukaltinok"];
    for entry in array(&index["files"]) {
        let entry = object(entry);
        let name = text(&entry["path"]);
        let bytes =
            fs::read(root.join(name)).unwrap_or_else(|error| panic!("read {name}: {error}"));
        assert_eq!(
            number(&entry["byte_size"]) as usize,
            bytes.len(),
            "{name} size"
        );
        assert_eq!(text(&entry["sha256"]), sha256_hex(&bytes), "{name} digest");
        assert_eq!(entry["derived"], Value::Bool(true));
        assert_eq!(text(&entry["source"]), format!("VACUUM {DB_SHA256}"));
        assert_eq!(number(&entry["sanitized_members"]), 138);
        assert_eq!(
            array(&entry["verbatim_members"])
                .iter()
                .map(number)
                .collect::<Vec<_>>(),
            vec![1824, 1864, 1927]
        );

        let decoded = String::from_utf8_lossy(&bytes);
        for needle in forbidden {
            assert!(
                !decoded.contains(needle),
                "secret marker {needle:?} in {name}"
            );
        }
        assert!(!email.is_match(&decoded), "email-like text in {name}");
    }
}

#[test]
fn d5_fixture_preserves_measured_tail_geometry_without_private_text() {
    let root = fixture_dir();
    let source = parse_json(&root.join("source-segment-v1.json"));
    let source = object(&source);
    assert_eq!(number(&source["normalization_version"]), 1);
    assert_eq!(
        source["excluded_additions"],
        serde_json::json!([{
            "kind": "recognized_compaction",
            "addition_kind": "claude_code_compaction_instruction"
        }])
    );

    let index = parse_json(&root.join("fixture-index-v1.json"));
    let members = array(&object(&index)["members"]);
    let messages = array(&source["messages"]);
    assert_eq!(messages.len(), 141);
    assert_eq!(members.len(), 141);

    let mut roles = BTreeMap::<&str, usize>::new();
    let mut kinds = BTreeMap::<&str, usize>::new();
    let mut kind_sources = BTreeMap::<&str, usize>::new();
    for (offset, (message, member)) in messages.iter().zip(members).enumerate() {
        let ordinal = 1799 + offset as u64;
        let position = 64 + offset as u64;
        let message = object(message);
        let member = object(member);
        assert_eq!(number(&message["ordinal"]), ordinal);
        assert_eq!(number(&message["position"]), position);
        assert_eq!(text(&message["mid"]), format!("ccm-{ordinal}"));
        assert_eq!(number(&member["ordinal"]), ordinal);
        assert_eq!(text(&member["length_source"]), "capture_13610");
        assert_eq!(text(&member["tool_links_source"]), "capture_13610");
        assert_eq!(text(&member["geometry"]), "measured");
        *kind_sources
            .entry(text(&member["kinds_source"]))
            .or_default() += 1;
        *roles.entry(text(&message["role"])).or_default() += 1;

        let blocks = array(&message["blocks"]);
        assert_eq!(number(&member["block_count"]) as usize, blocks.len());
        let mut member_length = 0;
        let probe = PROBES
            .iter()
            .find(|(probe_ordinal, _)| *probe_ordinal == ordinal);
        let mut probe_hits = 0;
        for (expected_index, block) in blocks.iter().enumerate() {
            let block = object(block);
            let block_index = number(&block["index"]);
            assert_eq!(block_index as usize, expected_index);
            *kinds.entry(text(&block["kind"])).or_default() += 1;
            let bytes = decode_base64(text(&block["bytes"]));
            member_length += bytes.len();
            if let Some((_, probe)) = probe {
                if bytes.starts_with(probe.as_bytes()) {
                    probe_hits += 1;
                    let mut expected = probe.as_bytes().to_vec();
                    expected.extend(stand_in(
                        ordinal,
                        block_index,
                        bytes.len() - probe.len(),
                        "probe-tail",
                    ));
                    assert_eq!(
                        bytes, expected,
                        "unapproved bytes in probe member {ordinal}"
                    );
                    continue;
                }
            }
            assert_eq!(
                bytes,
                stand_in(ordinal, block_index, bytes.len(), "block"),
                "unexpected bytes could expose a source-text run at {ordinal}#{block_index}"
            );
        }
        assert_eq!(member_length as u64, number(&member["source_byte_length"]));
        assert_eq!(
            probe_hits,
            usize::from(probe.is_some()),
            "probe member {ordinal}"
        );

        let decoded_member = blocks
            .iter()
            .flat_map(|block| decode_base64(text(&object(block)["bytes"])))
            .collect::<Vec<_>>();
        for (probe_ordinal, probe) in PROBES {
            let occurrences = decoded_member
                .windows(probe.len())
                .filter(|window| *window == probe.as_bytes())
                .count();
            assert_eq!(
                occurrences,
                usize::from(probe_ordinal == ordinal),
                "probe leakage at ordinal {ordinal}"
            );
        }
    }

    assert_eq!(
        roles,
        BTreeMap::from([("assistant", 70), ("system", 1), ("user", 70)])
    );
    assert_eq!(
        kinds,
        BTreeMap::from([
            ("reasoning", 38),
            ("text", 18),
            ("tool_result", 66),
            ("tool_use", 66),
        ])
    );
    assert_eq!(
        kind_sources,
        BTreeMap::from([("capture_13610", 58), ("db", 83)])
    );
}

#[test]
fn d5_fixture_private_source_run_rejection_when_available() {
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("repository root");
    let db_path =
        repo_root.join(".cortexkit/alfonso/reviews/d5-uncovered-tail-2026-09-11/d5-specimen.db");
    if !db_path.is_file() {
        eprintln!(
            "SKIP d5_fixture_private_source_run_rejection_when_available: private source DB absent"
        );
        return;
    }
    let db_bytes = fs::read(&db_path).expect("read private source DB");
    assert_eq!(sha256_hex(&db_bytes), DB_SHA256, "private source DB drift");
    let connection = Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("open private source DB read-only");
    let mut states = connection
        .prepare("SELECT session_id, meta FROM mc_cache_state")
        .expect("prepare predecessor lookup");
    let candidates = states
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .expect("query predecessor states")
        .filter_map(Result::ok)
        .filter(|(_, meta)| {
            serde_json::from_str::<Value>(meta).is_ok_and(|meta| {
                let meta = object(&meta);
                meta.get("coverage_ordinal").and_then(Value::as_u64) == Some(1798)
                    && meta.get("newest_live_ordinal").and_then(Value::as_u64) == Some(1939)
            })
        })
        .collect::<Vec<_>>();
    assert_eq!(candidates.len(), 1, "one private D5 predecessor");
    let session_id = &candidates[0].0;
    let mut tag_query = connection
        .prepare("SELECT block_id, source_bytes FROM mc_tags WHERE session_id=?1")
        .expect("prepare private tag lookup");
    let rows = tag_query
        .query_map([session_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
        })
        .expect("query private source tags");

    let approved_windows = PROBES
        .iter()
        .flat_map(|(_, probe)| probe.as_bytes().windows(20).map(<[u8]>::to_vec))
        .collect::<HashSet<_>>();
    let mut forbidden_windows = HashSet::new();
    for row in rows {
        let (block_id, source) = row.expect("private source tag row");
        let ordinal = block_id
            .strip_prefix("ccm-")
            .and_then(|value| value.split_once('#'))
            .and_then(|(ordinal, _)| ordinal.parse::<u64>().ok());
        if !ordinal.is_some_and(|ordinal| (1799..=1939).contains(&ordinal)) {
            continue;
        }
        forbidden_windows.extend(
            source
                .windows(20)
                .filter(|window| !approved_windows.contains(*window))
                .map(<[u8]>::to_vec),
        );
    }
    assert!(
        !forbidden_windows.is_empty(),
        "private source rejection set"
    );

    let source = parse_json(&fixture_dir().join("source-segment-v1.json"));
    for message in array(&object(&source)["messages"]) {
        let ordinal = number(&object(message)["ordinal"]);
        for block in array(&object(message)["blocks"]) {
            let block = object(block);
            let bytes = decode_base64(text(&block["bytes"]));
            assert!(
                bytes
                    .windows(20)
                    .all(|window| !forbidden_windows.contains(window)),
                "private 20-byte source run survived at {ordinal}#{}",
                number(&block["index"])
            );
        }
    }
}

#[test]
fn d5_fixture_tool_pairing_is_closed_with_deterministic_ids() {
    let source = parse_json(&fixture_dir().join("source-segment-v1.json"));
    let mut arcs =
        BTreeMap::<String, ((String, u64, u64), (String, u64, u64), usize, usize)>::new();
    for message in array(&object(&source)["messages"]) {
        for block in array(&object(message)["blocks"]) {
            let block = object(block);
            let links = array(&block["tool_links"]);
            let kind = text(&block["kind"]);
            if !matches!(kind, "tool_use" | "tool_result") {
                assert!(links.is_empty(), "non-tool blocks cannot carry tool arcs");
                continue;
            }
            assert_eq!(links.len(), 1, "each tool block has one closed arc");
            let link = object(&links[0]);
            let id = text(&link["tool_use_id"]).to_owned();
            assert!(id.starts_with("toolu_d5_"));
            let use_identity = identity_tuple(&link["use_identity"]);
            let result_identity = identity_tuple(&link["result_identity"]);
            let entry =
                arcs.entry(id)
                    .or_insert((use_identity.clone(), result_identity.clone(), 0, 0));
            assert_eq!(entry.0, use_identity);
            assert_eq!(entry.1, result_identity);
            if kind == "tool_use" {
                assert_eq!(
                    identity_tuple(&link["use_identity"]),
                    identity_tuple_from_block(message, block)
                );
                entry.2 += 1;
            } else {
                assert_eq!(
                    identity_tuple(&link["result_identity"]),
                    identity_tuple_from_block(message, block)
                );
                entry.3 += 1;
            }
        }
    }
    assert_eq!(arcs.len(), 66);
    assert!(arcs
        .values()
        .all(|(_, _, uses, results)| (*uses, *results) == (1, 1)));
}

fn identity_tuple_from_block(message: &Value, block: &Map<String, Value>) -> (String, u64, u64) {
    let message = object(message);
    (
        text(&message["mid"]).to_owned(),
        number(&block["index"]),
        number(&message["ordinal"]),
    )
}

#[test]
fn d5_fixture_manifest_and_archive_are_explicit_pending_scaffolds() {
    let root = fixture_dir();
    let manifest = parse_json(&root.join("expected-manifest-v1.json"));
    let archive = parse_json(&root.join("expected-archive-v1.json"));
    assert_eq!(object(&manifest)["digests_pending"], Value::Bool(true));
    assert_eq!(object(&archive)["digests_pending"], Value::Bool(true));
    assert_eq!(text(&object(&archive)["archive_id"]), DIGEST_PLACEHOLDER);

    let mut manifest_body = manifest.clone();
    object_mut(&mut manifest_body).remove("digests_pending");
    assert_eq!(object(&archive)["manifest"], manifest_body);
    assert_pending_digests(&manifest);
    assert_pending_digests(&archive);

    let manifest_messages = array(&object(&manifest)["messages"]);
    let projected = array(&object(&archive)["V"]);
    assert_eq!(manifest_messages.len(), 141);
    assert_eq!(projected.len(), 141);
    for (manifest_message, projected_message) in manifest_messages.iter().zip(projected) {
        let projected_message: Value =
            serde_json::from_slice(&decode_base64(text(projected_message)))
                .expect("projected message JSON");
        let manifest_message = object(manifest_message);
        let projected_message = object(&projected_message);
        assert_eq!(projected_message["ordinal"], manifest_message["ordinal"]);
        assert_eq!(projected_message["role"], manifest_message["role"]);
        assert_eq!(
            array(&projected_message["blocks"]).len(),
            array(&manifest_message["blocks"]).len()
        );
        for (projected_block, manifest_block) in array(&projected_message["blocks"])
            .iter()
            .zip(array(&manifest_message["blocks"]))
        {
            let projected_block = object(projected_block);
            let manifest_block = object(manifest_block);
            assert_eq!(projected_block["index"], manifest_block["index"]);
            assert_eq!(projected_block["kind"], manifest_block["kind"]);
            assert_eq!(projected_block["tool_links"], manifest_block["tool_links"]);
            assert_eq!(
                decode_base64(text(&projected_block["bytes"])).len() as u64,
                number(&object(&manifest_block["served"])["len"])
            );
        }
    }

    let applied = object(&archive)["A"]
        .as_object()
        .expect("applied state object");
    assert_eq!(number(&applied["schema_version"]), 1);
    let payload: Value =
        serde_json::from_slice(&decode_base64(text(&applied["canonical_payload"])))
            .expect("applied-state scaffold JSON");
    let payload = object(&payload);
    assert_eq!(array(&payload["units"]).len(), 17);
    assert_eq!(array(&payload["tags"]).len(), 83);
    assert_eq!(array(&payload["drops"]).len(), 29);
    assert_eq!(array(&payload["ledger"]).len(), 1);
    assert!(!contains_key(
        &Value::Object(payload.clone()),
        "token_count"
    ));
}

fn object_mut(value: &mut Value) -> &mut Map<String, Value> {
    value.as_object_mut().expect("expected mutable JSON object")
}

fn assert_pending_digests(value: &Value) {
    match value {
        Value::Object(fields) => {
            for (key, child) in fields {
                if key == "sha256" || key == "archive_id" {
                    assert_eq!(
                        text(child),
                        DIGEST_PLACEHOLDER,
                        "pending digest field {key}"
                    );
                } else {
                    assert_pending_digests(child);
                }
            }
        }
        Value::Array(items) => items.iter().for_each(assert_pending_digests),
        _ => {}
    }
}

fn contains_key(value: &Value, needle: &str) -> bool {
    match value {
        Value::Object(fields) => {
            fields.contains_key(needle) || fields.values().any(|value| contains_key(value, needle))
        }
        Value::Array(items) => items.iter().any(|value| contains_key(value, needle)),
        _ => false,
    }
}
