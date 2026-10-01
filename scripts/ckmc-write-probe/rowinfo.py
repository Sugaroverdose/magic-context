"""Print the session's mc_cache_state row version and blob sizes from a clone of the store."""
import json, os, shutil, sqlite3, subprocess, sys, tempfile
db, session = sys.argv[1], sys.argv[2]
tmp = tempfile.mkdtemp(prefix="rowinfo-")
try:
    for suffix in ("", "-wal"):
        if os.path.exists(db + suffix):
            subprocess.run(["cp", "-c", db + suffix, os.path.join(tmp, "x.db" + suffix)], check=True)
    conn = sqlite3.connect(os.path.join(tmp, "x.db"))
    row = conn.execute(
        "select row_version, length(core_state), length(meta) from mc_cache_state where session_id = ?",
        (session,)).fetchone()
    trace = conn.execute(
        "select length(scheduler_history) + length(scheduler_interesting_history) from mc_pass_trace where session_id = ?",
        (session,)).fetchone()
    tags = conn.execute("select count(*) from mc_tags where session_id = ?", (session,)).fetchone()
    print(json.dumps({"row_version": row and row[0], "core": row and row[1], "meta": row and row[2],
                      "pass_trace_bytes": trace and trace[0], "tags": tags[0]}))
finally:
    shutil.rmtree(tmp, ignore_errors=True)
