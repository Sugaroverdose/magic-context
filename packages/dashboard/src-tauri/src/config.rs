use serde::{Deserialize, Serialize};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Resolves paths to magic-context config files.
pub fn resolve_user_config_path() -> PathBuf {
    let config_dir = std::env::var("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| dirs::home_dir().unwrap_or_default().join(".config"));
    config_dir.join("opencode").join("magic-context.jsonc")
}

fn resolve_home_dir() -> PathBuf {
    #[cfg(test)]
    if let Some(home) = std::env::var_os("MAGIC_CONTEXT_DASHBOARD_TEST_HOME") {
        return PathBuf::from(home);
    }

    dirs::home_dir().unwrap_or_default()
}

/// Resolves the Pi user-level magic-context config path.
pub fn resolve_pi_config_path() -> PathBuf {
    resolve_home_dir()
        .join(".pi")
        .join("agent")
        .join("magic-context.jsonc")
}

/// Resolve the active magic-context config path for a project.
/// Checks root first, then `.opencode/` alt path. Returns the first that exists,
/// or root path as default for new config creation.
pub fn resolve_project_config_path(project_path: &str) -> PathBuf {
    let root_config = PathBuf::from(project_path).join("magic-context.jsonc");
    if root_config.exists() {
        return root_config;
    }
    let alt_config = PathBuf::from(project_path)
        .join(".opencode")
        .join("magic-context.jsonc");
    if alt_config.exists() {
        return alt_config;
    }
    // Default to root path for new configs
    root_config
}

/// Canonical dreamer task names (mirrors the plugin's task registry and the
/// frontend DreamerTasksField list). The dashboard renders this fixed set so
/// every project shows the same tasks regardless of its (possibly stale) per-
/// project scheduler snapshot in task_schedule_state.
pub const CANONICAL_DREAM_TASKS: [&str; 9] = [
    "map-memories",
    "verify",
    "verify-broad",
    "curate",
    "classify-memories",
    "retrospective",
    "maintain-docs",
    "evaluate-smart-notes",
    "review-user-memories",
];

/// Default cron per task (mirrors DEFAULT_TASK_SCHEDULES in the plugin schema and
/// the frontend). Applied when neither the project nor the global config sets a
/// schedule. maintain-docs defaults OFF (empty).
pub fn default_task_schedule(task: &str) -> &'static str {
    match task {
        "map-memories" => "0 2 * * *",
        "verify" => "0 3 * * *",
        "verify-broad" => "0 4 * * 0",
        "curate" => "0 4 * * 0",
        "classify-memories" => "0 6 * * *",
        "retrospective" => "0 5 * * *",
        "evaluate-smart-notes" => "0 3 * * *",
        "review-user-memories" => "0 3 * * *",
        _ => "",
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConfigFile {
    pub path: String,
    pub exists: bool,
    pub content: String,
    pub source: String, // "user" or "project"
}

pub type ConfigFileResponse = ConfigFile;

pub fn read_config(path: &PathBuf, source: &str) -> ConfigFile {
    let exists = path.exists();
    let content = if exists {
        std::fs::read_to_string(path).unwrap_or_default()
    } else {
        String::new()
    };

    ConfigFile {
        path: path.to_string_lossy().to_string(),
        exists,
        content,
        source: source.to_string(),
    }
}

pub fn write_config(path: &PathBuf, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }
    std::fs::write(path, content).map_err(|e| format!("Failed to write config: {}", e))?;
    Ok(())
}

pub fn write_project_config(project_path: &str, path: &Path, content: &str) -> Result<(), String> {
    let canonical_project = Path::new(project_path)
        .canonicalize()
        .map_err(|e| format!("Invalid project path: {e}"))?;
    validate_project_config_target(&canonical_project, path)?;
    write_config_atomic(path, content, Some(&canonical_project))
}

fn validate_project_config_target(canonical_project: &Path, path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Config path has no parent directory".to_string())?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|e| format!("Invalid config directory: {e}"))?;
    if !canonical_parent.starts_with(canonical_project) {
        return Err("Config path is outside the project directory".to_string());
    }

    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            let file_type = metadata.file_type();
            if file_type.is_symlink() {
                return Err(
                    "Refusing to write project config because the config path is a symlink"
                        .to_string(),
                );
            }
            if !file_type.is_file() {
                return Err(
                    "Refusing to write project config because the config path is not a regular file"
                        .to_string(),
                );
            }
            validate_existing_file_no_follow(path)?;
            let canonical_target = path
                .canonicalize()
                .map_err(|e| format!("Invalid config file path: {e}"))?;
            if !canonical_target.starts_with(canonical_project) {
                return Err("Config file resolves outside the project directory".to_string());
            }
        }
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Failed to inspect config path: {e}")),
    }

    Ok(())
}

#[cfg(unix)]
fn validate_existing_file_no_follow(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;

    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map(|_| ())
        .map_err(|e| format!("Failed to open config without following symlinks: {e}"))
}

#[cfg(not(unix))]
fn validate_existing_file_no_follow(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn write_config_atomic(
    path: &Path,
    content: &str,
    project_root: Option<&Path>,
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Config path has no parent directory".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {e}"))?;

    let temp_path = create_temp_config_file(parent, path.file_name(), content)?;
    if let Some(root) = project_root {
        if let Err(e) = validate_project_config_target(root, path) {
            let _ = std::fs::remove_file(&temp_path);
            return Err(e);
        }
    }

    replace_with_temp(&temp_path, path).map_err(|e| {
        let _ = std::fs::remove_file(&temp_path);
        format!("Failed to replace config atomically: {e}")
    })
}

fn create_temp_config_file(
    parent: &Path,
    file_name: Option<&std::ffi::OsStr>,
    content: &str,
) -> Result<PathBuf, String> {
    let file_name = file_name
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("magic-context.jsonc");
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();

    for attempt in 0..16u8 {
        let temp_path = parent.join(format!(
            ".{file_name}.{}.{}.{}.tmp",
            std::process::id(),
            stamp,
            attempt
        ));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW);
        }
        match options.open(&temp_path) {
            Ok(mut file) => {
                if let Err(e) = file.write_all(content.as_bytes()) {
                    let _ = std::fs::remove_file(&temp_path);
                    return Err(format!("Failed to write config: {e}"));
                }
                if let Err(e) = file.sync_all() {
                    let _ = std::fs::remove_file(&temp_path);
                    return Err(format!("Failed to sync config: {e}"));
                }
                return Ok(temp_path);
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Failed to create temporary config: {e}")),
        }
    }

    Err("Failed to create a unique temporary config path".to_string())
}

#[cfg(not(windows))]
fn replace_with_temp(temp_path: &Path, path: &Path) -> std::io::Result<()> {
    std::fs::rename(temp_path, path)
}

#[cfg(windows)]
fn replace_with_temp(temp_path: &Path, path: &Path) -> std::io::Result<()> {
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    std::fs::rename(temp_path, path)
}

#[tauri::command(async)]
pub fn read_pi_config() -> Result<ConfigFileResponse, String> {
    let path = resolve_pi_config_path();
    Ok(read_config(&path, "pi"))
}

#[tauri::command(async)]
pub fn write_pi_config(content: String) -> Result<(), String> {
    let path = resolve_pi_config_path();
    write_config(&path, &content)
}

#[tauri::command]
pub fn pi_config_path() -> String {
    resolve_pi_config_path().to_string_lossy().to_string()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProjectConfigEntry {
    pub project_name: String,
    pub worktree: String,
    pub config_path: String,
    pub exists: bool,
    pub alt_config_path: Option<String>,
    pub alt_exists: bool,
}

/// Discover projects with magic-context config files by scanning OpenCode project worktrees.
pub fn discover_project_configs() -> Vec<ProjectConfigEntry> {
    let opencode_db = {
        let data_dir = if cfg!(target_os = "windows") {
            match dirs::data_dir() {
                Some(d) => d,
                None => return vec![],
            }
        } else {
            std::env::var("XDG_DATA_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|_| {
                    dirs::home_dir()
                        .unwrap_or_default()
                        .join(".local")
                        .join("share")
                })
        };
        data_dir.join("opencode").join("opencode.db")
    };

    if !opencode_db.exists() {
        return vec![];
    }

    let conn = match rusqlite::Connection::open_with_flags(
        &opencode_db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(c) => c,
        Err(_) => return vec![],
    };

    let mut stmt = match conn.prepare("SELECT name, worktree FROM project") {
        Ok(s) => s,
        Err(_) => return vec![],
    };

    let rows: Vec<(String, String)> = match stmt.query_map([], |row| {
        Ok((
            row.get::<_, Option<String>>(0)?.unwrap_or_default(),
            row.get::<_, String>(1)?,
        ))
    }) {
        Ok(mapped) => mapped.flatten().collect(),
        Err(_) => return vec![],
    };

    let mut entries = Vec::new();
    for (name, worktree) in rows {
        let root_config = PathBuf::from(&worktree).join("magic-context.jsonc");
        let alt_config = PathBuf::from(&worktree)
            .join(".opencode")
            .join("magic-context.jsonc");
        let root_exists = root_config.exists();
        let alt_exists = alt_config.exists();

        // Only include projects that have at least one config file
        if root_exists || alt_exists {
            let display_name = if name.is_empty() {
                std::path::Path::new(&worktree)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| worktree.clone())
            } else {
                name
            };

            entries.push(ProjectConfigEntry {
                project_name: display_name,
                worktree: worktree.clone(),
                config_path: root_config.to_string_lossy().to_string(),
                exists: root_exists,
                alt_config_path: Some(alt_config.to_string_lossy().to_string()),
                alt_exists,
            });
        }
    }

    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pi_config_path_and_read_cover_missing_and_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("MAGIC_CONTEXT_DASHBOARD_TEST_HOME", dir.path());

        let expected = dir.path().join(".pi/agent/magic-context.jsonc");
        assert_eq!(resolve_pi_config_path(), expected);
        assert_eq!(pi_config_path(), expected.to_string_lossy());

        let missing = read_pi_config().unwrap();
        assert_eq!(missing.path, expected.to_string_lossy());
        assert!(!missing.exists);
        assert_eq!(missing.content, "");
        assert_eq!(missing.source, "pi");

        let content = "{\n  \"enabled\": true\n}";
        write_pi_config(content.to_string()).unwrap();

        let existing = read_pi_config().unwrap();
        assert!(existing.exists);
        assert_eq!(existing.content, content);
        assert_eq!(existing.source, "pi");

        std::env::remove_var("MAGIC_CONTEXT_DASHBOARD_TEST_HOME");
    }

    #[test]
    fn write_project_config_writes_regular_file_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let path = project.join("magic-context.jsonc");

        write_project_config(
            project.to_str().unwrap(),
            &path,
            "{\n  \"enabled\": true\n}\n",
        )
        .expect("initial write");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{\n  \"enabled\": true\n}\n"
        );

        write_project_config(
            project.to_str().unwrap(),
            &path,
            "{\n  \"enabled\": false\n}\n",
        )
        .expect("overwrite regular file");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{\n  \"enabled\": false\n}\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn write_project_config_refuses_symlink_target() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let outside = dir.path().join("outside.txt");
        std::fs::write(&outside, "do not overwrite").unwrap();
        let config_path = project.join("magic-context.jsonc");
        symlink(&outside, &config_path).unwrap();

        let err = write_project_config(
            project.to_str().unwrap(),
            &config_path,
            "{\"enabled\":true}\n",
        )
        .expect_err("symlinked config must be refused");
        assert!(err.contains("symlink"), "unexpected error: {err}");
        assert_eq!(
            std::fs::read_to_string(&outside).unwrap(),
            "do not overwrite"
        );
    }

    #[test]
    fn write_project_config_refuses_non_regular_target() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let config_path = project.join("magic-context.jsonc");
        std::fs::create_dir(&config_path).unwrap();

        let err = write_project_config(project.to_str().unwrap(), &config_path, "{}\n")
            .expect_err("directory target must be refused");
        assert!(err.contains("regular file"), "unexpected error: {err}");
    }
}
