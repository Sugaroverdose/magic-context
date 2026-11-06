import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Store-reset contract for the oracle legs (plan round-2 condition 1): the
 * fixture store (plugin context.db, host opencode.db, log roots) is seeded ONCE,
 * snapshotted as raw bytes, and restored byte-identically before every leg and
 * every self-test repeat. Only then is a wire diff a code diff.
 */

export type StoreEntry =
	| { kind: "file"; bytes: Buffer }
	/** Directory present in the seeded state; recreated on restore (possibly empty). */
	| { kind: "dir" }
	/** Broken symlink (or other unreadable special): site-created junk, deleted on restore, never recreated. */
	| { kind: "broken" };

export type StoreSnapshot = Map<string, StoreEntry>;

function readEntries(root: string): Array<{ rel: string; entry: StoreEntry }> {
	const entries: Array<{ rel: string; entry: StoreEntry }> = [];
	const walk = (dir: string, prefix: string): void => {
		for (const dirent of readdirSync(dir, { withFileTypes: true })) {
			const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
			const absolute = join(dir, dirent.name);
			if (dirent.isDirectory()) {
				walk(absolute, rel);
			} else if (dirent.isFile()) {
				entries.push({ rel, entry: { kind: "file", bytes: readFileSync(absolute) } });
			} else {
				try {
					entries.push({ rel, entry: { kind: "file", bytes: readFileSync(absolute) } });
				} catch {
					entries.push({ rel, entry: { kind: "broken" } });
				}
			}
		}
	};
	walk(root, "");
	return entries;
}

/**
 * Capture every readable file under `root` with its bytes, plus seeded top-level
 * directories; unreadable links survive as delete markers.
 */
export function snapshotStore(root: string): StoreSnapshot {
	const snapshot: StoreSnapshot = new Map();
	for (const dirent of readdirSync(root, { withFileTypes: true })) {
		if (dirent.isDirectory()) snapshot.set(dirent.name, { kind: "dir" });
	}
	for (const { rel, entry } of readEntries(root)) snapshot.set(rel, entry);
	return snapshot;
}

export function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Bring `root` back to exactly `snapshot`: delete site-created entries, restore
 * snapshotted bytes, then hash-assert every restored file. Throws before any boot
 * when restoration is not byte-identical — the caller's "restored file hashes
 * before boot" gate.
 */
export function restoreStore(
	root: string,
	snapshot: StoreSnapshot,
): { restored: number; removed: number } {
	let removed = 0;
	for (const { rel } of readEntries(root)) {
		if (snapshot.get(rel)?.kind !== "file") {
			rmSync(join(root, rel));
			removed += 1;
		}
	}
	// Dirs holding snapshotted files stay; freshly-empty site dirs go bottoms-up,
	// so a later boot starts from the seeded tree shape exactly.
	pruneEmptyDirectories(root, root);

	let restored = 0;
	for (const [rel, entry] of snapshot) {
		const target = join(root, rel);
		if (entry.kind === "file") {
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, entry.bytes);
			restored += 1;
		} else if (entry.kind === "dir") {
			mkdirSync(target, { recursive: true });
			restored += 1;
		}
	}

	// Byte-identity gate: every snapshotted file must have come back unchanged.
	for (const [rel, entry] of snapshot) {
		if (entry.kind !== "file") continue;
		const back = readFileSync(join(root, rel));
		if (!entry.bytes.equals(back)) {
			throw new Error(
				`store restore is not byte-identical: ${rel} (want ${sha256(entry.bytes)}, got ${sha256(back)})`,
			);
		}
	}
	const leftovers = readEntries(root).filter(({ rel }) => snapshot.get(rel)?.kind !== "file");
	if (leftovers.length > 0) {
		throw new Error(
			`store restore left site-created files: ${leftovers.map(({ rel }) => rel).join(", ")}`,
		);
	}
	return { restored, removed };
}

/** Remove directories whose subtree is empty after file deletion. Keeps `root`. */
function pruneEmptyDirectories(root: string, dir: string): void {
	if (dir === root) {
		for (const dirent of readdirSync(root, { withFileTypes: true })) {
			if (dirent.isDirectory()) pruneEmptyDirectories(root, join(root, dirent.name));
		}
		return;
	}
	const subtreeIsEmpty = (current: string): boolean => {
		let empty = true;
		for (const dirent of readdirSync(current, { withFileTypes: true })) {
			const child = join(current, dirent.name);
			if (dirent.isDirectory()) empty = subtreeIsEmpty(child) && empty;
			else empty = false;
		}
		return empty;
	};
	if (subtreeIsEmpty(dir)) rmSync(dir, { recursive: true });
}
