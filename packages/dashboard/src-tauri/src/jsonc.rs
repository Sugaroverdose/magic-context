//! Minimal JSONC helpers for the dashboard's config inspection.
//!
//! The dashboard reads user/project `magic-context.jsonc` files to detect
//! structure (e.g. whether a project declares a per-project `dreamer` override).
//! These mirror the frontend's conservative JSONC normalizer — they are used to
//! INSPECT config, never to round-trip user content (the plugin's loader is
//! authoritative).

use std::path::Path;

/// Strip JSONC line/block comments AND trailing commas, respecting string
/// literals, so the result parses as plain JSON.
pub fn strip_jsonc(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    while i < bytes.len() {
        let c = bytes[i] as char;
        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        if c == '"' {
            in_string = true;
            out.push(c);
            i += 1;
            continue;
        }
        let next = if i + 1 < bytes.len() {
            bytes[i + 1] as char
        } else {
            '\0'
        };
        if c == '/' && next == '/' {
            while i < bytes.len() && bytes[i] as char != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && next == '*' {
            i += 2;
            while i + 1 < bytes.len() {
                if bytes[i] as char == '*' && bytes[i + 1] as char == '/' {
                    break;
                }
                i += 1;
            }
            i += 2;
            continue;
        }
        out.push(c);
        i += 1;
    }

    // Drop trailing commas: `,}` / `,]` (optional whitespace between).
    let chars: Vec<char> = out.chars().collect();
    let mut cleaned = String::with_capacity(chars.len());
    let mut j = 0usize;
    while j < chars.len() {
        if chars[j] == ',' {
            let mut k = j + 1;
            while k < chars.len() && chars[k].is_whitespace() {
                k += 1;
            }
            if k < chars.len() && (chars[k] == '}' || chars[k] == ']') {
                j += 1;
                continue;
            }
        }
        cleaned.push(chars[j]);
        j += 1;
    }
    cleaned
}

/// True when the config file at `path` exists AND declares a non-empty `dreamer`
/// object — i.e. this project carries a per-project dreamer override rather than
/// inheriting the global config. Any read/parse failure → false (inherited).
pub fn config_has_dreamer_block(path: &Path) -> bool {
    let raw = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(_) => return false,
    };
    let value: serde_json::Value = match serde_json::from_str(&strip_jsonc(&raw)) {
        Ok(parsed) => parsed,
        Err(_) => return false,
    };
    value
        .get("dreamer")
        .and_then(|d| d.as_object())
        .map(|obj| !obj.is_empty())
        .unwrap_or(false)
}

/// Parse a config file's `dreamer.tasks` into a task→schedule map. Any read or
/// parse failure, or a missing block, yields an empty map (caller falls back to
/// global/default schedules). Used to compute the EFFECTIVE configured schedule
/// for a project rather than its (possibly stale) scheduler snapshot.
pub fn read_dreamer_task_schedules(
    path: &Path,
) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    let raw = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(_) => return map,
    };
    let value: serde_json::Value = match serde_json::from_str(&strip_jsonc(&raw)) {
        Ok(parsed) => parsed,
        Err(_) => return map,
    };
    if let Some(tasks) = value
        .get("dreamer")
        .and_then(|d| d.get("tasks"))
        .and_then(|t| t.as_object())
    {
        for (task, cfg) in tasks {
            if let Some(sched) = cfg.get("schedule").and_then(|s| s.as_str()) {
                map.insert(task.clone(), sched.to_string());
            }
        }
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_dreamer_task_schedules() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("c.jsonc");
        std::fs::write(
            &path,
            "{ \"dreamer\": { \"tasks\": { \"verify\": { \"schedule\": \"0 3 * * *\" }, \"curate\": { \"schedule\": \"\" } } } }",
        )
        .unwrap();
        let map = read_dreamer_task_schedules(&path);
        assert_eq!(map.get("verify").map(String::as_str), Some("0 3 * * *"));
        assert_eq!(map.get("curate").map(String::as_str), Some(""));
        assert_eq!(map.get("missing"), None);
    }

    #[test]
    fn strips_comments_and_trailing_commas() {
        let input = "{\n  // line\n  \"a\": 1, /* block */\n  \"b\": [1, 2,],\n}";
        let parsed: serde_json::Value = serde_json::from_str(&strip_jsonc(input)).unwrap();
        assert_eq!(parsed["a"], 1);
        assert_eq!(parsed["b"], serde_json::json!([1, 2]));
    }

    #[test]
    fn preserves_comment_like_text_inside_strings() {
        let input = "{ \"url\": \"http://x/y\", \"note\": \"a // b\" }";
        let parsed: serde_json::Value = serde_json::from_str(&strip_jsonc(input)).unwrap();
        assert_eq!(parsed["url"], "http://x/y");
        assert_eq!(parsed["note"], "a // b");
    }

    #[test]
    fn detects_dreamer_block_presence() {
        let dir = tempfile::tempdir().unwrap();
        let with = dir.path().join("with.jsonc");
        std::fs::write(&with, "{\n  // c\n  \"dreamer\": { \"model\": \"x\" },\n}").unwrap();
        assert!(config_has_dreamer_block(&with));

        let empty = dir.path().join("empty.jsonc");
        std::fs::write(&empty, "{ \"dreamer\": {} }").unwrap();
        assert!(!config_has_dreamer_block(&empty));

        let without = dir.path().join("without.jsonc");
        std::fs::write(&without, "{ \"enabled\": true }").unwrap();
        assert!(!config_has_dreamer_block(&without));

        let missing = dir.path().join("missing.jsonc");
        assert!(!config_has_dreamer_block(&missing));
    }
}
