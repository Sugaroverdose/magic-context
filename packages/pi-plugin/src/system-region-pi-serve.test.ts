import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import {
	encodeSystemRegionRow,
	writeSystemRegion,
} from "@magic-context/core/features/magic-context/system-region";
import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { promptSurfaceHashMaterial } from "@magic-context/core/shared/prompt-surface-runtime";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	clearPiSystemPromptSession,
	processSystemPromptForCache,
} from "./system-prompt";
import { createTestDb } from "./test-utils.test";

// Stage P2 (design §23): Pi serves the frozen system region from the watched
// system channel. These laws mirror the OpenCode-1 serve laws
// (system-region-serve.test.ts) onto the Pi surface.

const HOST = "You are a coding agent.\n\n## Magic Context\nstandby guidance";
const REGION_A = "<project-memory>#1: alpha fact</project-memory>";
const REGION_B = "<project-memory>#2: beta fact</project-memory>";

function serve(
	db: ReturnType<typeof createTestDb>,
	sessionId: string,
	systemPrompt: string,
	systemRegionLane: boolean,
	isCacheBusting = false,
) {
	return processSystemPromptForCache({
		db,
		sessionId,
		systemPrompt,
		isCacheBusting,
		systemRegionLane,
	});
}

describe("Pi system-region serve: frozen bytes in the watched system channel", () => {
	it("appends the stored region verbatim after the host bytes (lane on)", () => {
		const db = createTestDb();
		const sid = "pi-serve-verbatim";
		try {
			getOrCreateSessionMeta(db, sid);
			writeSystemRegion(db, sid, REGION_A);
			const result = serve(db, sid, HOST, true);
			// L2: served == stored payload, byte-exact, appended after H.
			expect(result.systemPrompt).toBe(`${HOST}\n\n${REGION_A}`);
		} finally {
			clearPiSystemPromptSession(sid);
			closeQuietly(db);
		}
	});

	it("hash watcher covers host bytes only: a rotation is not a watcher event", () => {
		const db = createTestDb();
		const sid = "pi-serve-watcher-split";
		try {
			getOrCreateSessionMeta(db, sid);
			const first = serve(db, sid, HOST, false);
			const hostHash = first.currentHash;
			writeSystemRegion(db, sid, REGION_A);
			const withRegion = serve(db, sid, HOST, true);
			expect(withRegion.hashChanged).toBe(false);
			expect(withRegion.currentHash).toBe(hostHash);
			// The persisted hash is the host-bytes hash — never the served
			// (host + region) bytes.
			const meta = getOrCreateSessionMeta(db, sid);
			expect(meta.systemPromptHash).toBe(
				createHash("md5")
					.update(promptSurfaceHashMaterial(HOST, undefined))
					.digest("hex"),
			);
			// Rotating the region again is still not a watcher event.
			writeSystemRegion(db, sid, REGION_B);
			const rotated = serve(db, sid, HOST, true);
			expect(rotated.hashChanged).toBe(false);
			expect(rotated.currentHash).toBe(hostHash);
			expect(rotated.systemPrompt).toBe(`${HOST}\n\n${REGION_B}`);
		} finally {
			clearPiSystemPromptSession(sid);
			closeQuietly(db);
		}
	});

	it("host guidance change still raises the refresh signal on the lane", () => {
		const db = createTestDb();
		const sid = "pi-serve-host-change";
		try {
			getOrCreateSessionMeta(db, sid);
			writeSystemRegion(db, sid, REGION_A);
			serve(db, sid, HOST, true);
			const changed = serve(db, sid, `${HOST}\nextra guidance line`, true);
			expect(changed.hashChanged).toBe(true);
			expect(changed.systemPrompt).toBe(
				`${HOST}\nextra guidance line\n\n${REGION_A}`,
			);
		} finally {
			clearPiSystemPromptSession(sid);
			closeQuietly(db);
		}
	});

	it("head-lane sessions never read the region column", () => {
		const db = createTestDb();
		const sid = "pi-serve-head-lane-inert";
		try {
			getOrCreateSessionMeta(db, sid);
			writeSystemRegion(db, sid, REGION_A);
			const result = serve(db, sid, HOST, false);
			// Byte-identical to the pre-lane behavior: no region append.
			expect(result.systemPrompt).toBe(HOST);
		} finally {
			clearPiSystemPromptSession(sid);
			closeQuietly(db);
		}
	});

	it("a corrupt region row is declined by name and never served", () => {
		const db = createTestDb();
		const sid = "pi-serve-corrupt";
		try {
			getOrCreateSessionMeta(db, sid);
			// Sentinel present, payload not servable (invalid UTF-8 that cannot
			// round-trip): the reader can only name it, never hand it over.
			db.prepare(
				"UPDATE session_meta SET cached_m0_bytes = ? WHERE session_id = ?",
			).run(
				Buffer.concat([
					encodeSystemRegionRow(""),
					Buffer.from([0xed, 0xa0, 0x80]),
				]),
				sid,
			);
			const result = serve(db, sid, HOST, true);
			expect(result.systemPrompt).toBe(HOST);
			expect(result.hashChanged).toBe(false);
		} finally {
			clearPiSystemPromptSession(sid);
			closeQuietly(db);
		}
	});

	it("a legacy head row serves nothing on the lane (reader contract)", () => {
		const db = createTestDb();
		const sid = "pi-serve-legacy-row";
		try {
			getOrCreateSessionMeta(db, sid);
			db.prepare(
				"UPDATE session_meta SET cached_m0_bytes = ?, cached_m1_bytes = ? WHERE session_id = ?",
			).run(
				Buffer.from(
					"<session-history>head-era baseline</session-history>",
					"utf8",
				),
				Buffer.from(
					"<session-history-since>delta</session-history-since>",
					"utf8",
				),
				sid,
			);
			const result = serve(db, sid, HOST, true);
			// Head bytes are never region bytes; the region stays empty until a
			// rotation installs it (D9).
			expect(result.systemPrompt).toBe(HOST);
		} finally {
			clearPiSystemPromptSession(sid);
			closeQuietly(db);
		}
	});

	it("token estimate covers host + region and re-estimates on rotation below the threshold", () => {
		const db = createTestDb();
		const sid = "pi-serve-tokens";
		try {
			getOrCreateSessionMeta(db, sid);
			writeSystemRegion(db, sid, REGION_A);
			serve(db, sid, HOST, true);
			const first = getOrCreateSessionMeta(db, sid).systemPromptTokens;
			expect(first).toBe(estimateTokens(`${HOST}\n\n${REGION_A}`));
			// A same-magnitude rotation is far below the ±50-token re-estimate
			// threshold — the served-region watermark must force the update
			// anyway (status/dashboard honesty, D3).
			writeSystemRegion(db, sid, REGION_B);
			serve(db, sid, HOST, true);
			const second = getOrCreateSessionMeta(db, sid).systemPromptTokens;
			expect(second).toBe(estimateTokens(`${HOST}\n\n${REGION_B}`));
			expect(Math.abs(second - first)).toBeLessThanOrEqual(50);
			// Control: an unchanged region replays the same estimate, no churn.
			serve(db, sid, HOST, true);
			expect(getOrCreateSessionMeta(db, sid).systemPromptTokens).toBe(second);
		} finally {
			clearPiSystemPromptSession(sid);
			closeQuietly(db);
		}
	});
});
