use regex::Regex;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;

/// Harness identifier — must match the strings used by the TypeScript-side
/// `HarnessId` type (`packages/plugin/src/shared/harness.ts`) and by the
/// per-harness temp-directory layout defined in
/// `packages/plugin/src/shared/data-path.ts:getMagicContextTempDir`.
#[derive(Debug, Clone, Copy)]
pub enum Harness {
    Opencode,
    Pi,
    Omp,
}

impl Harness {
    fn as_str(self) -> &'static str {
        match self {
            Harness::Opencode => "opencode",
            Harness::Pi => "pi",
            Harness::Omp => "omp",
        }
    }
}

/// Resolve the plugin log file for a specific harness.
///
/// The plugin writes separate logs per harness so a single machine running
/// each can produce an independent issue report:
///   - OpenCode → `${tmpdir}/opencode/magic-context/magic-context.log`
///   - Pi       → `${tmpdir}/pi/magic-context/magic-context.log`
///   - OMP      → `${tmpdir}/omp/magic-context/magic-context.log`
///
/// Mirrors the resolution done in TypeScript at
/// `packages/plugin/src/shared/data-path.ts:getMagicContextLogPath`. Kept
/// in sync manually because the dashboard doesn't import any TypeScript
/// source.
pub fn resolve_log_path_for(harness: Harness) -> PathBuf {
    // Mirror the plugin's getMagicContextLogPath: an explicit override wins over
    // the harness temp-dir default so the dashboard reads the same file the
    // plugin writes when the user relocates it. Blank/whitespace is treated as
    // unset.
    if let Some(env_path) = std::env::var("MAGIC_CONTEXT_LOG_PATH")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        return PathBuf::from(env_path);
    }

    resolve_log_path_from_temp_dir(&std::env::temp_dir(), harness)
}

fn resolve_log_path_from_temp_dir(temp_dir: &std::path::Path, harness: Harness) -> PathBuf {
    temp_dir
        .join(harness.as_str())
        .join("magic-context")
        .join("magic-context.log")
}

/// Resolve the module data directory using the same environment precedence as
/// the database reader. Log discovery must not depend on context.db existing.
fn resolve_storage_dir() -> Option<PathBuf> {
    if let Some(path) = std::env::var("MAGIC_CONTEXT_STORAGE_DIR")
        .ok()
        .map(|value| PathBuf::from(value.trim()))
        .filter(|path| !path.as_os_str().is_empty())
    {
        return path.is_absolute().then_some(path);
    }
    let data_home = std::env::var("XDG_DATA_HOME")
        .ok()
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".local").join("share")))?;
    Some(data_home.join("cortexkit").join("magic-context"))
}

/// Return every distinct legacy and fleet log the dashboard can read.
pub fn resolve_log_paths() -> Vec<PathBuf> {
    let mut paths = Vec::with_capacity(8);
    if let Some(override_path) = std::env::var("MAGIC_CONTEXT_LOG_PATH")
        .ok()
        .map(|value| PathBuf::from(value.trim()))
        .filter(|path| !path.as_os_str().is_empty())
    {
        paths.push(override_path);
    }
    for harness in [Harness::Opencode, Harness::Pi, Harness::Omp] {
        let path = resolve_log_path_from_temp_dir(&std::env::temp_dir(), harness);
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    if let Some(storage_dir) = resolve_storage_dir() {
        let logs = storage_dir.join("logs");
        for name in [
            "magic-context.opencode.log",
            "magic-context.pi.log",
            "magic-context.omp.log",
            "magic-context.log",
        ] {
            let path = logs.join(name);
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
    }
    paths
}

#[derive(Debug, Serialize, Clone)]
pub struct LogEntry {
    pub timestamp: String,
    pub level: Option<String>,
    pub component: String,
    pub session_id: String,
    pub tags: Vec<String>,
    pub message: String,
    pub kv: HashMap<String, String>,
    pub raw: String,
    pub cache_read: Option<i64>,
    pub cache_write: Option<i64>,
    pub hit_ratio: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedLogLine {
    pub ts: String,
    pub level: Option<String>,
    pub session: Option<String>,
    pub tags: Vec<String>,
    pub message: String,
    pub kv: HashMap<String, String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct CacheEvent {
    pub timestamp: String,
    pub session_id: String,
    pub cache_read: i64,
    pub cache_write: i64,
    pub input_tokens: i64,
    pub hit_ratio: f64,
    pub cause: Option<String>,
    pub severity: String, // "stable", "warning", "bust", "full_bust"
}

#[derive(Debug, Serialize, Clone)]
pub struct SessionCacheStats {
    pub session_id: String,
    pub event_count: usize,
    pub total_cache_read: i64,
    pub total_cache_write: i64,
    pub total_input: i64,
    pub hit_ratio: f64,
    pub last_timestamp: String,
    pub bust_count: usize,
}

lazy_static::lazy_static! {
    static ref LEGACY_LOG_LINE_RE: Regex = Regex::new(
        r"^\[([^\]]+)\] \[magic-context\]\[([^\]]*)\]\s+(.*)$"
    ).unwrap();
    static ref FLEET_LOG_LINE_RE: Regex = Regex::new(
        r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) (TRACE|DEBUG|INFO |WARN |ERROR) magic-context (.+)$"
    ).unwrap();
}

fn tokenize(input: &str) -> Option<Vec<(usize, &str)>> {
    let bytes = input.as_bytes();
    let mut tokens = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        while index < bytes.len() && bytes[index] == b' ' {
            index += 1;
        }
        if index >= bytes.len() {
            break;
        }
        let start = index;
        let mut quoted = false;
        let mut escaped = false;
        while index < bytes.len() {
            match bytes[index] {
                _ if escaped => escaped = false,
                b'\\' if quoted => escaped = true,
                b'"' => quoted = !quoted,
                b' ' if !quoted => break,
                _ => {}
            }
            index += 1;
        }
        if quoted || escaped {
            return None;
        }
        tokens.push((start, &input[start..index]));
    }
    Some(tokens)
}

fn decode_escapes(value: &str) -> Option<String> {
    let mut decoded = String::new();
    let mut chars = value.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            decoded.push(ch);
            continue;
        }
        match chars.next()? {
            'n' => decoded.push('\n'),
            '"' => decoded.push('"'),
            '\\' => decoded.push('\\'),
            _ => return None,
        }
    }
    Some(decoded)
}

fn parse_field(token: &str) -> Option<(String, String)> {
    let (key, raw_value) = token.split_once('=')?;
    if key.is_empty()
        || !key.chars().enumerate().all(|(index, ch)| {
            ch == '_' || ch.is_ascii_alphanumeric() || (index > 0 && ".-".contains(ch))
        })
        || key.chars().next()?.is_ascii_digit()
    {
        return None;
    }
    let value = if raw_value.starts_with('"') {
        if raw_value.len() < 2 || !raw_value.ends_with('"') {
            return None;
        }
        decode_escapes(&raw_value[1..raw_value.len() - 1])?
    } else {
        if raw_value.is_empty() || raw_value.contains('"') {
            return None;
        }
        raw_value.to_string()
    };
    Some((key.to_string(), value))
}

fn split_message_and_fields(
    input: &str,
    decode_message: bool,
) -> Option<(String, HashMap<String, String>)> {
    let tokens = tokenize(input)?;
    if tokens.is_empty() {
        return None;
    }
    let mut field_start = tokens.len();
    for index in (0..tokens.len()).rev() {
        if parse_field(tokens[index].1).is_none() {
            break;
        }
        field_start = index;
    }
    if field_start == 0 {
        return None;
    }
    let message_end = tokens
        .get(field_start)
        .map(|(start, _)| *start)
        .unwrap_or(input.len());
    let raw_message = input[..message_end].trim_end();
    let message = if decode_message {
        decode_escapes(raw_message)?
    } else {
        raw_message.to_string()
    };
    if message.is_empty() {
        return None;
    }
    let mut fields = HashMap::new();
    for (_, token) in &tokens[field_start..] {
        let (key, value) = parse_field(token)?;
        fields.insert(key, value);
    }
    Some((message, fields))
}

pub fn parse_log_record(line: &str) -> Option<ParsedLogLine> {
    if line.contains('\u{1b}') {
        return None;
    }
    if let Some(caps) = FLEET_LOG_LINE_RE.captures(line) {
        let ts = caps.get(1)?.as_str().to_string();
        chrono::DateTime::parse_from_rfc3339(&ts).ok()?;
        let level = caps.get(2)?.as_str().trim().to_string();
        let body = caps.get(3)?.as_str();
        let tokens = tokenize(body)?;
        let mut index = 0;
        let mut session = None;
        let mut tags = Vec::new();
        if tokens.get(index)?.1.starts_with("session=") {
            let (_, value) = parse_field(tokens[index].1)?;
            let (issuer, id) = value.split_once(':')?;
            if issuer.is_empty() || id.is_empty() || value == "global" {
                return None;
            }
            session = Some(id.to_string());
            index += 1;
        }
        while let Some((_, token)) = tokens.get(index) {
            if !token.starts_with("tag=") {
                break;
            }
            let (_, tag) = parse_field(token)?;
            if tag.is_empty() {
                return None;
            }
            tags.push(tag);
            index += 1;
        }
        let body_start = tokens.get(index)?.0;
        let (message, kv) = split_message_and_fields(&body[body_start..], true)?;
        return Some(ParsedLogLine {
            ts,
            level: Some(level),
            session,
            tags,
            message,
            kv,
        });
    }
    let caps = LEGACY_LOG_LINE_RE.captures(line)?;
    let ts = caps.get(1)?.as_str().to_string();
    chrono::DateTime::parse_from_rfc3339(&ts).ok()?;
    let raw_session = caps.get(2)?.as_str().trim();
    let session = if raw_session.is_empty() || raw_session == "global" {
        None
    } else {
        Some(raw_session.to_string())
    };
    let (message, kv) = split_message_and_fields(caps.get(3)?.as_str(), false)?;
    Some(ParsedLogLine {
        ts,
        level: None,
        session,
        tags: Vec::new(),
        message,
        kv,
    })
}

pub fn parse_log_line(line: &str) -> Option<LogEntry> {
    let record = parse_log_record(line)?;
    let component = if record.message.starts_with("event ") {
        "event"
    } else if record.message.starts_with("transform") {
        "transform"
    } else if record.message.starts_with("[dreamer]") || record.message.contains("dreamer") {
        "dreamer"
    } else if record.message.contains("historian") || record.message.contains("compartment") {
        "historian"
    } else if record.message.contains("nudge") {
        "nudge"
    } else if record.message.contains("note-nudge") || record.message.contains("note nudge") {
        "note-nudge"
    } else {
        "general"
    }
    .to_string();

    let cache_read = record
        .kv
        .get("cache.read")
        .and_then(|value| value.parse().ok());
    let cache_write = record
        .kv
        .get("cache.write")
        .and_then(|value| value.parse().ok());
    let hit_ratio = match (cache_read, cache_write) {
        (Some(read), Some(write)) => {
            let total = read + write;
            Some(if total > 0 {
                read as f64 / total as f64
            } else {
                0.0
            })
        }
        _ => None,
    };

    Some(LogEntry {
        timestamp: record.ts,
        level: record.level,
        component,
        session_id: record.session.unwrap_or_default(),
        tags: record.tags,
        message: record.message,
        kv: record.kv,
        raw: line.to_string(),
        cache_read,
        cache_write,
        hit_ratio,
    })
}

pub fn extract_cache_events(entries: &[LogEntry]) -> Vec<CacheEvent> {
    let mut events = Vec::new();
    let mut last: Option<(&str, i64, i64, i64)> = None;

    for (i, entry) in entries.iter().enumerate() {
        if let (Some(read), Some(write)) = (entry.cache_read, entry.cache_write) {
            let input_tokens = entry
                .kv
                .get("tokens.input")
                .and_then(|value| value.parse::<i64>().ok())
                .unwrap_or(0);

            // Deduplicate consecutive identical events (message.updated fires twice)
            let key = (entry.session_id.as_str(), read, write, input_tokens);
            if last == Some(key) {
                continue;
            }
            last = Some(key);

            // Total prompt tokens = uncached input + cache read + cache write
            let total_prompt = input_tokens + read + write;
            if total_prompt == 0 {
                continue;
            }

            // Real cache hit rate: what fraction of prompt was served from cache
            let ratio = read as f64 / total_prompt as f64;

            // Determine severity and cause based on real hit ratio
            let (severity, cause) = if read == 0 && write > 0 {
                let cause = detect_bust_cause(entries, i);
                // First message and provider eviction are not real busts
                let sev = if cause.starts_with("First message") {
                    "info"
                } else if cause.starts_with("Provider-side") {
                    "warning"
                } else {
                    "full_bust"
                };
                (sev.to_string(), Some(cause))
            } else if ratio < 0.5 {
                let cause = detect_bust_cause(entries, i);
                ("bust".to_string(), Some(cause))
            } else if ratio < 0.9 {
                ("warning".to_string(), None)
            } else {
                ("stable".to_string(), None)
            };

            events.push(CacheEvent {
                timestamp: entry.timestamp.clone(),
                session_id: entry.session_id.clone(),
                cache_read: read,
                cache_write: write,
                input_tokens,
                hit_ratio: ratio,
                cause,
                severity,
            });
        }
    }

    events
}

/// Aggregate cache events into per-session stats, sorted by last activity (most recent first).
pub fn aggregate_session_cache_stats(
    events: &[CacheEvent],
    limit: usize,
) -> Vec<SessionCacheStats> {
    use std::collections::HashMap;

    struct Accum {
        event_count: usize,
        total_read: i64,
        total_write: i64,
        total_input: i64,
        last_timestamp: String,
        bust_count: usize,
    }

    let mut map: HashMap<String, Accum> = HashMap::new();

    for event in events {
        if event.session_id.is_empty() {
            continue;
        }
        let entry = map.entry(event.session_id.clone()).or_insert(Accum {
            event_count: 0,
            total_read: 0,
            total_write: 0,
            total_input: 0,
            last_timestamp: String::new(),
            bust_count: 0,
        });
        entry.event_count += 1;
        entry.total_read += event.cache_read;
        entry.total_write += event.cache_write;
        entry.total_input += event.input_tokens;
        entry.last_timestamp = event.timestamp.clone();
        if event.severity == "bust" || event.severity == "full_bust" {
            entry.bust_count += 1;
        }
    }

    let mut stats: Vec<SessionCacheStats> = map
        .into_iter()
        .map(|(session_id, acc)| {
            let total_prompt = acc.total_read + acc.total_write + acc.total_input;
            let hit_ratio = if total_prompt > 0 {
                acc.total_read as f64 / total_prompt as f64
            } else {
                0.0
            };
            SessionCacheStats {
                session_id,
                event_count: acc.event_count,
                total_cache_read: acc.total_read,
                total_cache_write: acc.total_write,
                total_input: acc.total_input,
                hit_ratio,
                last_timestamp: acc.last_timestamp,
                bust_count: acc.bust_count,
            }
        })
        .collect();

    // Sort by last_timestamp descending (most recent first)
    stats.sort_by(|a, b| b.last_timestamp.cmp(&a.last_timestamp));
    stats.truncate(limit);
    stats
}

fn detect_bust_cause(entries: &[LogEntry], event_idx: usize) -> String {
    let event = &entries[event_idx];

    // Look at surrounding log entries for context
    let window_start = event_idx.saturating_sub(10);
    let window_end = std::cmp::min(event_idx + 3, entries.len());

    let mut causes = Vec::new();

    // Check if this is the first cache event for this session
    let is_first_session_event = !entries[..event_idx].iter().any(|e| {
        e.session_id == event.session_id
            && e.cache_read.is_some()
            && (e.cache_read.unwrap_or(0) > 0 || e.cache_write.unwrap_or(0) > 0)
    });

    if is_first_session_event {
        return "First message (new session)".to_string();
    }

    // Check if the transform was a defer pass (no plugin-side mutations)
    let is_defer_pass = entries[window_start..window_end]
        .iter()
        .any(|e| e.session_id == event.session_id && e.message.contains("decision=defer"));

    // If cache.read=0 on a defer pass, it's provider-side eviction
    if is_defer_pass && event.cache_read == Some(0) && event.cache_write.unwrap_or(0) > 0 {
        let has_plugin_mutation = entries[window_start..window_end].iter().any(|e| {
            e.session_id == event.session_id
                && (e.message.contains("Execute pass")
                    || e.message.contains("triggering flush")
                    || e.message.contains("system prompt hash changed")
                    || e.message.contains("variant change"))
        });
        if !has_plugin_mutation {
            return "Provider-side cache eviction".to_string();
        }
    }

    for entry in &entries[window_start..window_end] {
        if entry.session_id != event.session_id {
            continue;
        }
        let msg = &entry.message;
        if msg.contains("Execute pass") || (msg.contains("applied") && msg.contains("ops")) {
            causes.push("Execute pass".to_string());
        }
        if msg.contains("compartments") && msg.contains("→") {
            causes.push("Historian output".to_string());
        }
        if msg.contains("variant change") || msg.contains("Variant change") {
            causes.push("Variant change".to_string());
        }
        if msg.contains("system prompt hash") {
            causes.push("System prompt hash change".to_string());
        }
        if msg.contains("restart")
            || msg.contains("Restart")
            || msg.contains("injection cache cleared")
        {
            causes.push("App restart".to_string());
        }
        if msg.contains("note nudge") && msg.contains("deliver") {
            causes.push("Note nudge delivered".to_string());
        }
        if msg.contains("heuristic cleanup") || msg.contains("tool tags dropped") {
            causes.push("Heuristic cleanup".to_string());
        }
    }

    if causes.is_empty() {
        "Unknown cause".to_string()
    } else {
        causes.dedup();
        causes.join(", ")
    }
}

/// Read the last N lines from the log file using seek-from-end
/// to avoid loading the entire file into memory.
pub fn read_log_tail(path: &PathBuf, max_lines: usize) -> Vec<LogEntry> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };

    let file_len = match file.seek(SeekFrom::End(0)) {
        Ok(len) => len,
        Err(_) => return Vec::new(),
    };

    if file_len == 0 {
        return Vec::new();
    }

    // Read backwards in 64KB chunks until we have enough newlines
    let chunk_size: u64 = 65536;
    let mut tail_bytes = Vec::new();
    let mut newline_count = 0;
    let mut pos = file_len;

    while pos > 0 && newline_count <= max_lines {
        let read_size = std::cmp::min(chunk_size, pos);
        pos -= read_size;
        if file.seek(SeekFrom::Start(pos)).is_err() {
            break;
        }
        let mut buf = vec![0u8; read_size as usize];
        if file.read_exact(&mut buf).is_err() {
            break;
        }
        // Count newlines in this chunk
        newline_count += buf.iter().filter(|&&b| b == b'\n').count();
        // Prepend chunk
        buf.append(&mut tail_bytes);
        tail_bytes = buf;
    }

    let text = String::from_utf8_lossy(&tail_bytes);
    let lines: Vec<&str> = text.lines().collect();

    // Take only the last max_lines
    let start = if lines.len() > max_lines {
        lines.len() - max_lines
    } else {
        0
    };

    lines[start..]
        .iter()
        .filter_map(|line| parse_log_line(line))
        .collect()
}

/// Read recent entries from every harness log, retaining the newest entries
/// across the combined stream. Plugin timestamps are ISO-8601 strings, so their
/// lexical order is chronological.
pub fn read_log_tails(paths: &[PathBuf], max_lines: usize) -> Vec<LogEntry> {
    let mut entries: Vec<LogEntry> = paths
        .iter()
        .flat_map(|path| read_log_tail(path, max_lines))
        .collect();
    entries.sort_by(|left, right| left.timestamp.cmp(&right.timestamp));

    let first_to_keep = entries.len().saturating_sub(max_lines);
    entries.drain(0..first_to_keep);
    entries
}

#[cfg(test)]
mod tests {
    use super::{
        extract_cache_events, parse_log_line, parse_log_record, read_log_tails,
        resolve_log_path_for, resolve_log_path_from_temp_dir, resolve_log_paths, Harness,
    };
    use std::path::{Path, PathBuf};
    use std::sync::{Mutex, OnceLock};

    // The env var is process-global; serialize the tests that mutate it.
    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn parses_authority_fixture_and_legacy_grammar() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../cli/src/lib/__fixtures__/log_format_golden.json"
        ))
        .unwrap();
        let fleet_case = fixture["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|case| case["event"]["module"] == "magic-context")
            .unwrap();
        let parsed = parse_log_record(fleet_case["line"].as_str().unwrap()).unwrap();
        assert_eq!(parsed.ts, "2026-09-05T10:41:03.130Z");
        assert_eq!(parsed.level.as_deref(), Some("WARN"));
        assert_eq!(parsed.session.as_deref(), Some("ses_00fc88222ffe"));
        assert_eq!(parsed.tags, vec!["perf"]);
        assert_eq!(parsed.message, "transform stage folded");
        assert_eq!(parsed.kv.get("ms").map(String::as_str), Some("412"));
        assert_eq!(parsed.kv.get("retry").map(String::as_str), Some("2"));

        let legacy = parse_log_record(
            "[2026-09-05T10:41:04.130Z] [magic-context][global] transform complete cache.read=7 cache.write=2",
        )
        .unwrap();
        assert_eq!(legacy.level, None);
        assert_eq!(legacy.session, None);
        assert_eq!(legacy.message, "transform complete");
        assert_eq!(legacy.kv.get("cache.read").map(String::as_str), Some("7"));
    }

    #[test]
    fn fleet_fields_feed_existing_cache_telemetry() {
        let entry = parse_log_line(
            "2026-09-05T10:41:03.130Z INFO  magic-context session=opencode:ses_cache cache event cache.read=70 cache.write=20 tokens.input=10",
        )
        .unwrap();
        assert_eq!(entry.message, "cache event");
        assert_eq!(entry.cache_read, Some(70));
        assert_eq!(entry.cache_write, Some(20));
        let events = extract_cache_events(&[entry]);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].input_tokens, 10);
        assert_eq!(events[0].hit_ratio, 0.7);
    }

    #[test]
    fn rejects_wrong_grammar_without_silently_splitting() {
        assert!(parse_log_record(
            "2026-09-05T10:41:03.130Z WARN magic-context session=opencode:ses_bad transform failed: boom"
        )
        .is_none());
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../cli/src/lib/__fixtures__/log_format_golden.json"
        ))
        .unwrap();
        for case in fixture["parse_rejects"].as_array().unwrap() {
            assert!(
                parse_log_record(case["line"].as_str().unwrap()).is_none(),
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn resolve_log_path_for_uses_harness_fallback_when_env_unset() {
        let _guard = env_lock();
        std::env::remove_var("MAGIC_CONTEXT_LOG_PATH");

        assert_eq!(
            resolve_log_path_for(Harness::Opencode),
            std::env::temp_dir()
                .join("opencode")
                .join("magic-context")
                .join("magic-context.log")
        );
        assert_eq!(
            resolve_log_path_for(Harness::Pi),
            std::env::temp_dir()
                .join("pi")
                .join("magic-context")
                .join("magic-context.log")
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_log_paths_preserve_tmpdir_and_harness_subdirectories() {
        let tmpdir = Path::new("/var/folders/example/T");

        assert_eq!(
            resolve_log_path_from_temp_dir(tmpdir, Harness::Opencode),
            tmpdir.join("opencode/magic-context/magic-context.log")
        );
        assert_eq!(
            resolve_log_path_from_temp_dir(tmpdir, Harness::Pi),
            tmpdir.join("pi/magic-context/magic-context.log")
        );
        assert_eq!(
            resolve_log_path_from_temp_dir(tmpdir, Harness::Omp),
            tmpdir.join("omp/magic-context/magic-context.log")
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_log_paths_preserve_temp_and_harness_subdirectories() {
        let tmpdir = Path::new(r"C:\Users\example\AppData\Local\Temp");

        assert_eq!(
            resolve_log_path_from_temp_dir(tmpdir, Harness::Opencode),
            tmpdir.join("opencode/magic-context/magic-context.log")
        );
        assert_eq!(
            resolve_log_path_from_temp_dir(tmpdir, Harness::Pi),
            tmpdir.join("pi/magic-context/magic-context.log")
        );
        assert_eq!(
            resolve_log_path_from_temp_dir(tmpdir, Harness::Omp),
            tmpdir.join("omp/magic-context/magic-context.log")
        );
    }

    #[test]
    fn resolve_log_paths_reads_all_harnesses_when_no_override_is_set() {
        let _guard = env_lock();
        std::env::remove_var("MAGIC_CONTEXT_LOG_PATH");

        let paths = resolve_log_paths();
        for harness in [Harness::Opencode, Harness::Pi, Harness::Omp] {
            assert!(paths.contains(&resolve_log_path_for(harness)));
        }
        assert!(paths
            .iter()
            .any(|path| path.ends_with("logs/magic-context.opencode.log")));
        assert!(paths
            .iter()
            .any(|path| path.ends_with("logs/magic-context.pi.log")));
        assert!(paths
            .iter()
            .any(|path| path.ends_with("logs/magic-context.omp.log")));
        assert!(paths
            .iter()
            .any(|path| path.ends_with("logs/magic-context.log")));
    }

    #[test]
    fn resolve_log_paths_keeps_standard_families_with_a_shared_override() {
        let _guard = env_lock();
        let custom = std::env::temp_dir()
            .join("custom")
            .join("magic-context.log");
        std::env::set_var(
            "MAGIC_CONTEXT_LOG_PATH",
            custom.to_string_lossy().to_string(),
        );

        let paths = resolve_log_paths();
        assert_eq!(paths.first(), Some(&custom));
        assert_eq!(paths.iter().filter(|path| *path == &custom).count(), 1);
        assert!(paths.contains(&resolve_log_path_from_temp_dir(
            &std::env::temp_dir(),
            Harness::Omp
        )));

        std::env::remove_var("MAGIC_CONTEXT_LOG_PATH");
    }

    #[test]
    fn read_log_tails_combines_harness_logs_in_timestamp_order() {
        let dir = tempfile::tempdir().unwrap();
        let opencode = dir.path().join("opencode.log");
        let pi = dir.path().join("pi.log");
        std::fs::write(
            &opencode,
            "[2026-01-01T00:00:00.000Z] [magic-context][opencode-session] OpenCode entry\n",
        )
        .unwrap();
        std::fs::write(
            &pi,
            "[2026-01-01T00:00:01.000Z] [magic-context][pi-session] Pi entry\n",
        )
        .unwrap();

        let entries = read_log_tails(&[opencode, pi], 10);

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].session_id, "opencode-session");
        assert_eq!(entries[1].session_id, "pi-session");
    }

    #[test]
    fn resolve_log_path_for_honors_magic_context_log_path_override() {
        let _guard = env_lock();
        let custom = std::env::temp_dir()
            .join("custom")
            .join("magic-context.log");
        std::env::set_var(
            "MAGIC_CONTEXT_LOG_PATH",
            custom.to_string_lossy().to_string(),
        );

        assert_eq!(
            resolve_log_path_for(Harness::Opencode),
            PathBuf::from(&custom)
        );
        assert_eq!(resolve_log_path_for(Harness::Pi), PathBuf::from(&custom));

        std::env::remove_var("MAGIC_CONTEXT_LOG_PATH");
    }

    #[test]
    fn resolve_log_path_for_ignores_blank_magic_context_log_path() {
        let _guard = env_lock();
        std::env::set_var("MAGIC_CONTEXT_LOG_PATH", "   ");

        assert_eq!(
            resolve_log_path_for(Harness::Pi),
            std::env::temp_dir()
                .join("pi")
                .join("magic-context")
                .join("magic-context.log")
        );

        std::env::remove_var("MAGIC_CONTEXT_LOG_PATH");
    }
}
