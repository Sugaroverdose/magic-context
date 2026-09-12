#!/usr/bin/env python3
"""Generate the sanitized, derived D5 uncovered-tail replay fixture."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import sqlite3
from pathlib import Path
from typing import Any

DB_SHA256 = "f589668287f41abaeb2a6526ee6d6f9d162e7ed80b1650f1ca5ec0a45984b8c0"
CAPTURE_SHA256 = "766c26e1fab1129e0866e275c22d79e111a4382140f4334095279c46f26f526b"
SOURCE_LABEL = f"VACUUM {DB_SHA256}"
GENERATOR_PATH = "packages/plugin/scripts/gen-d5-specimen-fixture.py"
DIGEST_PLACEHOLDER = "<computed-by-slice-0>"
PREDECESSOR_KEY = "d5-fixture-predecessor"
ATTEMPT_ID = "d5-fixture-attempt-0001"
TAIL_START = 1799
TAIL_END = 1939
CAPTURE_START_POSITION = 64
PROBE_ORDINALS = (1824, 1864, 1927)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()


def compact_json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def assert_digest(path: Path, expected: str, label: str) -> bytes:
    data = path.read_bytes()
    actual = sha256(data)
    if actual != expected:
        raise SystemExit(f"refusing {label}: expected sha256 {expected}, got {actual}")
    return data


def stand_in(ordinal: int, block_index: int, length: int, namespace: str = "block") -> bytes:
    marker = f"[sanitized:{namespace}:{ordinal}:{block_index}:{length}]".encode()
    return (marker * ((length + len(marker) - 1) // len(marker)))[:length]


def source_identity(ordinal: int, block_index: int) -> dict[str, Any]:
    return {"mid": f"ccm-{ordinal}", "index": block_index, "ordinal": ordinal}


def provider_blocks(message: dict[str, Any]) -> list[dict[str, Any]]:
    content = message["content"]
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    if not isinstance(content, list) or not all(isinstance(block, dict) for block in content):
        raise SystemExit("capture contains an unsupported message content shape")
    return content


def segment_blocks(ordinal: int, message: dict[str, Any]) -> list[dict[str, Any]]:
    blocks = provider_blocks(message)
    if ordinal == 1939:
        if len(blocks) != 2 or blocks[1].get("type") != "text":
            raise SystemExit("expected the recognized compaction addition at 1939#1")
        return blocks[:1]
    return blocks


def contract_kind(provider_kind: str) -> str:
    return {
        "thinking": "reasoning",
        "redacted_thinking": "redacted_reasoning",
        "tool_use": "tool_use",
        "tool_result": "tool_result",
        "text": "text",
        "image": "image",
        "document": "document",
    }.get(provider_kind, "other")


def db_kind(contract_block_kind: str) -> str:
    return "tool_call" if contract_block_kind == "tool_use" else contract_block_kind


def normalized_block_bytes(block: dict[str, Any]) -> bytes:
    # The frozen contract leaves NativeBlock.bytes normalization open. This fixture
    # uses canonical compact JSON after lifting type and tool-link IDs into fields.
    payload = {
        key: value
        for key, value in block.items()
        if key not in {"type", "id", "tool_use_id"}
    }
    return json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode()


def parse_block_id(block_id: str) -> tuple[int, int]:
    mid, raw_index = block_id.split("#", 1)
    if not mid.startswith("ccm-"):
        raise SystemExit(f"unexpected block identity {block_id}")
    return int(mid.removeprefix("ccm-")), int(raw_index)


def rewrite_tool_ids(tail: list[dict[str, Any]]) -> tuple[dict[str, str], dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    rewritten: dict[str, str] = {}
    uses: dict[str, dict[str, Any]] = {}
    results: dict[str, dict[str, Any]] = {}
    sequence = 0
    for ordinal, message in zip(range(TAIL_START, TAIL_END + 1), tail):
        for index, block in enumerate(segment_blocks(ordinal, message)):
            kind = block.get("type")
            if kind == "tool_use":
                original = block.get("id")
                if not isinstance(original, str) or original in uses:
                    raise SystemExit(f"invalid or duplicate tool use at {ordinal}#{index}")
                sequence += 1
                rewritten[original] = f"toolu_d5_{sequence:04d}"
                uses[original] = source_identity(ordinal, index)
            elif kind == "tool_result":
                original = block.get("tool_use_id")
                if not isinstance(original, str) or original in results:
                    raise SystemExit(f"invalid or duplicate tool result at {ordinal}#{index}")
                results[original] = source_identity(ordinal, index)
    if uses.keys() != results.keys():
        missing_results = sorted(uses.keys() - results.keys())
        missing_uses = sorted(results.keys() - uses.keys())
        raise SystemExit(
            f"tool arcs are not closed: missing results={len(missing_results)}, missing uses={len(missing_uses)}"
        )
    return rewritten, uses, results


def tool_links(
    block: dict[str, Any],
    rewritten: dict[str, str],
    uses: dict[str, dict[str, Any]],
    results: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    original = block.get("id") if block.get("type") == "tool_use" else block.get("tool_use_id")
    if not isinstance(original, str):
        return []
    return [
        {
            "tool_use_id": rewritten[original],
            "use_identity": uses[original],
            "result_identity": results[original],
        }
    ]


def load_source_state(db_path: Path, probes: list[dict[str, Any]]) -> dict[str, Any]:
    connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    candidates: list[tuple[str, dict[str, Any], dict[str, Any]]] = []
    for row in connection.execute("SELECT session_id, core_state, meta FROM mc_cache_state"):
        meta = json.loads(row["meta"])
        if meta.get("coverage_ordinal") == 1798 and meta.get("newest_live_ordinal") == 1939:
            candidates.append((row["session_id"], json.loads(row["core_state"]), meta))
    if len(candidates) != 1:
        raise SystemExit(f"expected one D5 predecessor state, found {len(candidates)}")
    session_id, core, meta = candidates[0]

    tags = [
        dict(row)
        for row in connection.execute(
            "SELECT tag_number, block_id, kind, token_count, source_bytes "
            "FROM mc_tags WHERE session_id=? ORDER BY tag_number",
            (session_id,),
        )
        if TAIL_START <= parse_block_id(row["block_id"])[0] <= TAIL_END
    ]
    by_number = {row["tag_number"]: row for row in tags}
    for probe in probes:
        tag = by_number.get(probe["tag"])
        if tag is None or tag["block_id"] != probe["block_id"]:
            raise SystemExit(f"probe tag {probe['tag']} is absent or has the wrong identity")
        if probe["string"].encode() not in tag["source_bytes"]:
            raise SystemExit(f"probe tag {probe['tag']} does not contain its approved string")

    red_units = {
        unit["key"].removeprefix("red:"): unit
        for unit in core.get("frozen_units", [])
        if unit.get("key", "").startswith("red:")
        and TAIL_START <= parse_block_id(unit["key"].removeprefix("red:"))[0] <= TAIL_END
    }
    drops = [
        dict(row)
        for row in connection.execute(
            "SELECT target_id, command_id FROM pending_agent_drops "
            "WHERE session_id=? ORDER BY id",
            (session_id,),
        )
    ]
    ledgers = [
        dict(row)
        for row in connection.execute(
            "SELECT command_id, first_applied_at_ms, disposition "
            "FROM mc_reduce_command_ledger WHERE session_id=? ORDER BY command_id",
            (session_id,),
        )
    ]
    connection.close()
    return {
        "meta": meta,
        "tags": tags,
        "tagged_ordinals": {parse_block_id(row["block_id"])[0] for row in tags},
        "red_units": red_units,
        "drops": drops,
        "ledgers": ledgers,
    }


def validate_db_kinds(state: dict[str, Any], tail: list[dict[str, Any]]) -> None:
    identities = state["meta"].get("block_identity_by_mid", {})
    tagged_ordinals = state["tagged_ordinals"]
    for ordinal, message in zip(range(TAIL_START, TAIL_END + 1), tail):
        if ordinal not in tagged_ordinals:
            continue
        expected = identities.get(f"ccm-{ordinal}")
        if not isinstance(expected, list):
            raise SystemExit(f"tagged member {ordinal} has no DB block-kind fingerprints")
        actual = [db_kind(contract_kind(block.get("type", "other"))) for block in segment_blocks(ordinal, message)]
        persisted = [block.get("kind_tag") for block in expected]
        if actual != persisted:
            raise SystemExit(f"capture/DB block-kind mismatch at ordinal {ordinal}")


def build_fixture(
    state: dict[str, Any], capture: dict[str, Any], probes: list[dict[str, Any]]
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
    messages = capture.get("messages")
    if not isinstance(messages, list) or len(messages) != 205:
        raise SystemExit("capture must contain exactly 205 messages")
    tail = messages[CAPTURE_START_POSITION:]
    if len(tail) != 141:
        raise SystemExit("capture tail must contain exactly 141 messages")
    roles = {role: sum(message.get("role") == role for message in tail) for role in ("assistant", "user", "system")}
    if roles != {"assistant": 70, "user": 70, "system": 1}:
        raise SystemExit(f"unexpected tail roles: {roles}")

    validate_db_kinds(state, tail)
    rewritten, uses, results = rewrite_tool_ids(tail)
    probe_by_ordinal = {
        parse_block_id(probe["block_id"])[0]: probe["string"].encode() for probe in probes
    }
    if tuple(sorted(probe_by_ordinal)) != PROBE_ORDINALS:
        raise SystemExit("probe ordinals do not match the D5 contract")

    source_messages: list[dict[str, Any]] = []
    manifest_messages: list[dict[str, Any]] = []
    projected_messages: list[str] = []
    member_sources: list[dict[str, Any]] = []
    for position, ordinal, message in zip(
        range(CAPTURE_START_POSITION, CAPTURE_START_POSITION + len(tail)),
        range(TAIL_START, TAIL_END + 1),
        tail,
    ):
        native_blocks: list[dict[str, Any]] = []
        manifest_blocks: list[dict[str, Any]] = []
        normalized_blocks: list[dict[str, Any]] = []
        probe = probe_by_ordinal.get(ordinal)
        probe_written = False
        source_length = 0
        for index, block in enumerate(segment_blocks(ordinal, message)):
            raw = normalized_block_bytes(block)
            source_length += len(raw)
            sanitized = stand_in(ordinal, index, len(raw))
            if probe is not None and probe in raw:
                if probe_written:
                    raise SystemExit(f"probe appears in multiple blocks at ordinal {ordinal}")
                sanitized = probe + stand_in(ordinal, index, len(raw) - len(probe), "probe-tail")
                probe_written = True
            links = tool_links(block, rewritten, uses, results)
            kind = contract_kind(block.get("type", "other"))
            native_block = {
                "index": index,
                "kind": kind,
                "bytes": b64(sanitized),
                "provenance": {"kind": "native"},
                "tool_links": links,
            }
            native_blocks.append(native_block)

            block_id = f"ccm-{ordinal}#{index}"
            applied = state["red_units"].get(block_id)
            if applied is None:
                served = sanitized
                unit_key = None
            else:
                payload = applied["frozen_payload"].encode()
                served = stand_in(ordinal, index, len(payload), "unit")
                unit_key = applied["key"]
            manifest_blocks.append(
                {
                    "index": index,
                    "kind": kind,
                    "predecessor_identity": source_identity(ordinal, index),
                    "provenance": {
                        "kind": "native",
                        "attempt_id": ATTEMPT_ID,
                        "predecessor_key": PREDECESSOR_KEY,
                        "message_position": position,
                    },
                    "source": {"len": len(sanitized), "sha256": DIGEST_PLACEHOLDER},
                    "served": {"len": len(served), "sha256": DIGEST_PLACEHOLDER},
                    "applied_unit": unit_key,
                    "tool_links": links,
                }
            )
            normalized_blocks.append(
                {
                    "index": index,
                    "kind": kind,
                    "bytes": b64(served),
                    "provenance": {"kind": "native"},
                    "tool_links": links,
                }
            )
        if probe is not None and not probe_written:
            raise SystemExit(f"capture member {ordinal} does not contain its approved probe")

        source_messages.append(
            {
                "position": position,
                "ordinal": ordinal,
                "mid": f"ccm-{ordinal}",
                "role": message["role"],
                "blocks": native_blocks,
            }
        )
        manifest_messages.append(
            {
                "ordinal": ordinal,
                "native_mid": f"ccm-{ordinal}",
                "native_position": position,
                "role": message["role"],
                "blocks": manifest_blocks,
            }
        )
        projected_messages.append(
            b64(
                compact_json_bytes(
                    {
                        "position": position,
                        "ordinal": ordinal,
                        "role": message["role"],
                        "blocks": normalized_blocks,
                    }
                )
            )
        )
        member_sources.append(
            {
                "ordinal": ordinal,
                "block_count": len(native_blocks),
                "source_byte_length": source_length,
                "length_source": "capture_13610",
                "kinds_source": "db" if ordinal in state["tagged_ordinals"] else "capture_13610",
                "tool_links_source": "capture_13610",
                "geometry": "measured",
            }
        )

    source_segment = {
        "normalization_version": 1,
        "messages": source_messages,
        "excluded_additions": [
            {"kind": "recognized_compaction", "addition_kind": "claude_code_compaction_instruction"}
        ],
    }
    manifest = {
        "schema_version": 1,
        "normalization_version": 1,
        "encoding_version": 1,
        "messages": manifest_messages,
    }
    expected_manifest = {**manifest, "digests_pending": True}
    applied_state = build_applied_state(state, probe_by_ordinal)
    expected_archive = {
        "schema_version": 1,
        "archive_id": DIGEST_PLACEHOLDER,
        "encoding_version": 1,
        "manifest": manifest,
        "V": projected_messages,
        "A": {"schema_version": 1, "canonical_payload": b64(compact_json_bytes(applied_state))},
        "digests_pending": True,
    }
    return source_segment, expected_manifest, expected_archive, member_sources


def build_applied_state(state: dict[str, Any], probes: dict[int, bytes]) -> dict[str, Any]:
    command_ids = sorted(
        {row["command_id"] for row in state["drops"]}
        | {row["command_id"] for row in state["ledgers"]}
    )
    rewritten_commands = {command_id: f"cmd-d5-{index + 1:04d}" for index, command_id in enumerate(command_ids)}
    units = []
    for block_id, unit in sorted(state["red_units"].items(), key=lambda item: parse_block_id(item[0])):
        ordinal, index = parse_block_id(block_id)
        payload = unit["frozen_payload"].encode()
        units.append(
            {
                "unit": unit["key"],
                "kind": unit["kind"],
                "durability_class": unit["durability_class"],
                "reset_rule": unit["reset_rule"],
                "bytes": b64(stand_in(ordinal, index, len(payload), "unit")),
            }
        )
    tags = []
    for row in state["tags"]:
        ordinal, index = parse_block_id(row["block_id"])
        source = stand_in(ordinal, index, len(row["source_bytes"]), "tag")
        probe = probes.get(ordinal)
        if probe is not None:
            source = probe + stand_in(ordinal, index, len(source) - len(probe), "tag-tail")
        tags.append(
            {
                "tag_number": row["tag_number"],
                "target": source_identity(ordinal, index),
                "kind": row["kind"],
                "source_len": len(source),
                "source_bytes": b64(source),
            }
        )
    drops = [
        {
            "command_id": rewritten_commands[row["command_id"]],
            "target": source_identity(*parse_block_id(row["target_id"])),
            "state": "pending",
        }
        for row in state["drops"]
    ]
    ledger = [
        {
            "command_id": rewritten_commands[row["command_id"]],
            "first_applied": row["first_applied_at_ms"] is not None,
            "disposition": row["disposition"],
        }
        for row in state["ledgers"]
    ]
    return {"units": units, "tags": tags, "drops": drops, "ledger": ledger}


def readme_text() -> str:
    return f"""# D5 specimen fixture

This is the MC-owned, **DERIVED** and sanitized specimen for the D5 uncovered predecessor tail. It carries 141 ordered members (1799–1939) for joint Magic Context/Thalamus replay without committing the private source capture or store.

Provenance:

- store membership and tagged-member kinds: `{SOURCE_LABEL}`
- byte lengths, untagged-member kinds, roles, block geometry, and tool links: capture `13610-req-body`, SHA-256 `{CAPTURE_SHA256}`
- attribute counts: lengths: 141 from capture; kinds: 83 from db, 58 from capture; tool links: 141 from capture

Sanitization preserves message order, ordinals, roles, normalized source block counts and kinds, per-block UTF-8 byte lengths, reduction lengths, and closed tool-use/result arcs. The recognized compaction instruction at 1939#1 is excluded as a contract provenance addition rather than treated as predecessor source. Only the approved probe string in each of ordinals 1824, 1864, and 1927 remains verbatim; all surrounding payload bytes are deterministic stand-ins. It does **not** preserve token counts, historian quality, semantic content outside those probes, or provider-valid reasoning signatures. Signature bytes are opaque synthetic test data.

`NativeBlock.bytes` uses compact, key-sorted JSON of each provider block after `type`, `id`, and `tool_use_id` are lifted into contract fields. Scalar text is normalized as `{{"text": ...}}`. The frozen contract leaves this representation open. Archive `V` entries are base64 compact JSON renderings of `NormalizedMessage` in contract field order; the applied-state payload is a stable JSON scaffold for units, tags, drops, and ledger without token counts or clocks.

`expected-manifest-v1.json` and `expected-archive-v1.json` are scaffolds, not oracles. They are structurally ready but not digest-valid while `digests_pending` is true. Slice 0 must compute every placeholder from an **independent** reference implementation and hand-checked CE1 preimage vectors—not from the codec under test—then freeze the results.

Regenerate from the two private inputs:

```sh
python3 {GENERATOR_PATH} \\
  /path/to/d5-specimen.db \\
  /path/to/13610-req-body
```

The generator refuses either input unless its SHA-256 matches the values above. `fixture-index-v1.json` catalogs every sibling fixture file; it cannot hash itself without a recursive self-reference.
"""


def write_fixture(
    output: Path,
    source_segment: dict[str, Any],
    manifest: dict[str, Any],
    archive: dict[str, Any],
    member_sources: list[dict[str, Any]],
) -> None:
    output.mkdir(parents=True, exist_ok=True)
    payloads = {
        "source-segment-v1.json": json_bytes(source_segment),
        "expected-manifest-v1.json": json_bytes(manifest),
        "expected-archive-v1.json": json_bytes(archive),
        "README.md": readme_text().encode(),
    }
    for name, data in payloads.items():
        (output / name).write_bytes(data)

    entries = []
    redaction = (
        "138 members fully replaced with deterministic equal-length stand-ins; "
        "three probe members retain only their approved probe string and sanitize all remaining payload bytes"
    )
    for name, data in payloads.items():
        entries.append(
            {
                "path": name,
                "byte_size": len(data),
                "sha256": sha256(data),
                "derived": True,
                "source": SOURCE_LABEL,
                "length_geometry_source": f"capture_13610 {CAPTURE_SHA256}",
                "sanitized_members": 138,
                "verbatim_members": list(PROBE_ORDINALS),
                "redaction_method": redaction,
                "generation_script": GENERATOR_PATH,
            }
        )
    index = {
        "schema_version": 1,
        "readiness": "scaffold",
        "source_db_sha256": DB_SHA256,
        "capture_13610_sha256": CAPTURE_SHA256,
        "members": member_sources,
        "files": entries,
    }
    (output / "fixture-index-v1.json").write_bytes(json_bytes(index))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("db", type=Path, help="private d5-specimen.db")
    parser.add_argument("capture", type=Path, help="private 13610-req-body")
    parser.add_argument("--output", type=Path, help="fixture output directory")
    args = parser.parse_args()

    db_path = args.db.resolve()
    capture_path = args.capture.resolve()
    assert_digest(db_path, DB_SHA256, "source database")
    capture_bytes = assert_digest(capture_path, CAPTURE_SHA256, "13610 capture")
    probes_path = db_path.parent / "d5-content-probes.json"
    probes = json.loads(probes_path.read_text())
    if not isinstance(probes, list) or len(probes) != 3:
        raise SystemExit("expected exactly three probes beside the source database")
    state = load_source_state(db_path, probes)
    capture = json.loads(capture_bytes)
    source_segment, manifest, archive, member_sources = build_fixture(state, capture, probes)
    output = args.output or Path(__file__).resolve().parents[3] / "crates/mc-module/tests/fixtures/d5-specimen"
    write_fixture(output, source_segment, manifest, archive, member_sources)
    print(f"wrote deterministic D5 specimen to {output}")


if __name__ == "__main__":
    main()
