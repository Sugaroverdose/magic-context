# Research Spike: sqlite-vec Viability for Magic Context Embeddings

## TL;DR Verdict

| Metric / Dimension | Brute-Force JS (Bun) | sqlite-vec (Node 24) | Verdict / Recommendation |
| :--- | :--- | :--- | :--- |
| **Bun Compatibility** | **100% Native** (No deps) | **Broken** (Bun lacks dynamic loading) | **DO NOT ADOPT sqlite-vec** |
| **Node 24 Compatibility** | **100% Native** (No deps) | **Works** (Requires `allowExtension: true`) | Brute-force JS is the clear winner for the interim. |
| **384-dim KNN (100K)** | 40.60 ms | 23.18 ms (1.75x faster) | sqlite-vec is slightly faster but not worth the complexity. |
| **1024-dim KNN (100K)** | 81.85 ms | 57.82 ms (1.41x faster) | JS performance is highly acceptable for interim use. |
| **4096-dim KNN (50K)** | 143.33 ms | 124.35 ms (1.15x faster) | Performance gap narrows as dimension increases. |
| **Insert Rate (1024-dim)** | ~147K vectors/s (as BLOB) | ~11.9K vectors/s (12x slower) | sqlite-vec suffers from severe write amplification. |
| **Insert Rate (4096-dim)** | ~39.7K vectors/s (as BLOB) | ~1.3K vectors/s (30x slower) | Backfilling large dimensions is extremely slow in sqlite-vec. |
| **Operational Risk** | **Zero** | **High** (Bundling, Electron ASAR, dynamic loading) | JS requires no native binaries or build-time configuration. |

### Recommendation
**Reject `sqlite-vec` for the interim in-plugin story and use brute-force JS (Float32Array dot product loop) instead.**
Since a future Rust daemon will eventually own vector search long-term, the interim solution must prioritize operational simplicity, zero-dependency reliability, and cross-runtime compatibility.
- **Bun is a hard blocker:** Bun's built-in `bun:sqlite` does not support dynamic extension loading on macOS/Linux, throwing `This build of sqlite3 does not support dynamic extension loading`.
- **Write Amplification:** `sqlite-vec`'s chunk-based storage design causes quadratic write amplification during inserts, dropping insert throughput to just 1,342 vectors/sec for 4096-dim.
- **Brute-Force JS is fast enough:** A pure JS scan over 100K 1024-dim vectors takes only ~81 ms in Bun, which is perfectly acceptable for an interim solution.

---

## Per-Question Findings

### 1. Extension Loading on All Three Runtimes

*   **`bun:sqlite`:** **Failed.** Bun compiles its built-in SQLite statically and disables dynamic extension loading. Calling `db.loadExtension(...)` throws:
    ```
    error: This build of sqlite3 does not support dynamic extension loading
    ```
    This is a hard blocker for Bun-based environments.
*   **`node:sqlite`:** **Works.** On Node 24.16.0, `new DatabaseSync(path, { allowExtension: true })` followed by `db.loadExtension(sqliteVec.getLoadablePath())` successfully loads the extension. No command-line flags are required.
*   **Distribution & Electron Gotchas:**
    *   The `sqlite-vec` npm package ships prebuilds as optional dependencies for: `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, and `windows-x64`.
    *   It resolves the binary path at runtime using `require.resolve` on the platform-specific package name (e.g., `sqlite-vec-darwin-arm64/vec0.dylib`).
    *   **Electron Gotcha:** In bundled Electron apps, `require.resolve` often fails because bundlers (like esbuild or webpack) cannot statically resolve the dynamic path. Furthermore, Electron's ASAR archive cannot load native `.dylib`/`.so`/`.dll` files directly; they must be explicitly unpacked using `asarUnpack` in the builder configuration, adding significant packaging complexity.

### 2. Performance & Storage

*   **KNN Query Times (Top-50):**
    *   **384-dim (100K):** `sqlite-vec` = 23.18 ms vs. Bun JS = 40.60 ms (sqlite-vec is 1.75x faster).
    *   **1024-dim (100K):** `sqlite-vec` = 57.82 ms vs. Bun JS = 81.85 ms (sqlite-vec is 1.41x faster).
    *   **4096-dim (50K):** `sqlite-vec` = 124.35 ms vs. Bun JS = 143.33 ms (sqlite-vec is 1.15x faster).
*   **Insert Throughput (Transaction-Batched):**
    *   **384-dim:** `sqlite-vec` = 139,646 vectors/s vs. BLOB = 295,556 vectors/s.
    *   **1024-dim:** `sqlite-vec` = 11,929 vectors/s vs. BLOB = 147,731 vectors/s (12x slower).
    *   **4096-dim:** `sqlite-vec` = 1,342 vectors/s vs. BLOB = 39,797 vectors/s (30x slower).
    *   *Why is sqlite-vec so slow on inserts?* `sqlite-vec` groups vectors into chunks (e.g., 1024 vectors per chunk) and stores them as a single large BLOB in a shadow table (`vec_items_vector_chunks00`). When inserting vectors one-by-one, the extension must read the existing chunk BLOB, append the new vector, and write it back. This causes quadratic write amplification that worsens dramatically with higher dimensions.
*   **DB File Size Growth:**
    *   **384-dim (100K):** `sqlite-vec` = 149.35 MB vs. BLOB = 195.80 MB (0.76x).
    *   **1024-dim (100K):** `sqlite-vec` = 394.59 MB vs. BLOB = 439.58 MB (0.90x).
    *   **4096-dim (50K):** `sqlite-vec` = 785.88 MB vs. BLOB = 805.73 MB (0.98x).
    *   *Why is sqlite-vec smaller?* By packing 1024 vectors into a single chunk BLOB, `sqlite-vec` avoids SQLite's per-row overhead and overflow page overhead, which is significant for large BLOBs.

### 3. Operational Fit

*   **WAL & Concurrency:** `sqlite-vec` virtual tables can live alongside normal tables in a shared DB. WAL mode and concurrent reads/writes work as expected.
*   **Compatibility (Process WITHOUT Extension Loaded):**
    *   **Critical Finding:** A process (like the Tauri dashboard using `rusqlite` or an older plugin version) **can successfully open the DB, read from normal tables, and write to normal tables** without loading the `sqlite-vec` extension.
    *   SQLite resolves virtual tables lazily. It only throws an error (`no such module: vec0`) if a query explicitly references the `vec0` virtual table. This means introducing `sqlite-vec` tables will not break the Tauri dashboard's ability to read/write other tables.
*   **Filtered KNN (Metadata Filtering):**
    *   `sqlite-vec` does **not** support pre-filtering via standard joins. A query like `join documents d on d.id = v.rowid where d.project_path = 'X' and v.embedding match ? and v.k = 5` performs the KNN query first, and then filters the top 5 results. If none of the top 5 match the project path, it returns 0 results.
    *   **Workaround:** Using a subquery with `rowid IN (select id from documents where project_path = 'X')` works correctly because SQLite passes the list of matching rowids to the virtual table, allowing it to filter before sorting.
    *   **Performance:** Subquery IN with 10K matching rows (out of 100K) takes **34.62 ms** (slightly slower than the full 100K KNN search of 23.18 ms due to subquery overhead, but still very fast).

---

## Appendix: Raw Benchmark Output

### Node 24.16.0 Benchmark Output
```
=== Running sqlite-vec Benchmark under Node ===

--- Corpus: 384 (100000 x 384-dim) ---
Generating vectors...
vec0 Insert throughput: 139646 vectors/sec (0.72s total)
vec0 KNN (top-50) average time: 23.18 ms
BLOB Insert throughput: 295556 vectors/sec (0.34s total)
vec0 DB file size: 149.35 MB
BLOB DB file size: 195.80 MB
Size ratio (vec0 / BLOB): 0.76x

--- Corpus: 1024 (100000 x 1024-dim) ---
Generating vectors...
vec0 Insert throughput: 11929 vectors/sec (8.38s total)
vec0 KNN (top-50) average time: 57.82 ms
BLOB Insert throughput: 147731 vectors/sec (0.68s total)
vec0 DB file size: 394.59 MB
BLOB DB file size: 439.58 MB
Size ratio (vec0 / BLOB): 0.90x

--- Corpus: 4096 (50000 x 4096-dim) ---
Generating vectors...
vec0 Insert throughput: 1342 vectors/sec (37.25s total)
vec0 KNN (top-50) average time: 124.35 ms
BLOB Insert throughput: 39797 vectors/sec (1.26s total)
vec0 DB file size: 785.88 MB
BLOB DB file size: 805.73 MB
Size ratio (vec0 / BLOB): 0.98x

=== Running Brute-Force JS Benchmark under Node ===
Generating 100000 vectors of 384 dims...
Generated in 0.37s
JS KNN (top-50) average time: 56.05 ms
Generating 100000 vectors of 1024 dims...
Generated in 0.52s
JS KNN (top-50) average time: 90.01 ms
Generating 50000 vectors of 4096 dims...
Generated in 0.97s
JS KNN (top-50) average time: 141.46 ms
```

### Bun 1.3.14 Benchmark Output
```
=== Running Brute-Force JS Benchmark under Bun ===
Generating 100000 vectors of 384 dims...
Generated in 0.12s
JS KNN (top-50) average time: 40.60 ms
Generating 100000 vectors of 1024 dims...
Generated in 0.24s
JS KNN (top-50) average time: 81.85 ms
Generating 50000 vectors of 4096 dims...
Generated in 0.46s
JS KNN (top-50) average time: 143.33 ms
```

### Filtered KNN Benchmark Output (Node 24.16.0)
```
=== Running Filtered KNN Benchmarks ===
Subquery IN (10K matching rows, k=50) average time: 34.62 ms
Subquery IN (90K matching rows, k=50) average time: 38.74 ms
Join with filter (k=4096, project_a) average time: 89.66 ms
```
