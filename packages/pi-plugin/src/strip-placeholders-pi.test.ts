import { describe, expect, it } from "bun:test";
import { getStrippedPlaceholderIds } from "@magic-context/core/features/magic-context/storage";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { stripPiDroppedPlaceholderMessages } from "./strip-placeholders-pi";
import { assistantMessage, createTestDb, userMessage } from "./test-utils.test";

describe("stripPiDroppedPlaceholderMessages", () => {
	it("discovers placeholder-only Pi messages on cache-busting passes", () => {
		const db = createTestDb();
		try {
			const messages = [
				userMessage("keep", 1),
				assistantMessage("[dropped §2§]", 2),
				userMessage([{ type: "text", text: "[dropped §3§]" }], 3),
				assistantMessage("real answer", 4),
			];

			const result = stripPiDroppedPlaceholderMessages({
				db,
				sessionId: "ses-placeholders",
				messages,
				isCacheBusting: true,
			});

			expect(result).toEqual({ removed: 2, discovered: 2 });
			expect(messages.map((m) => (m as { role: string }).role)).toEqual([
				"user",
				"assistant",
			]);
			expect(getStrippedPlaceholderIds(db, "ses-placeholders").size).toBe(2);
		} finally {
			closeQuietly(db);
		}
	});

	it("replays persisted stripping on defer passes without discovering new ids", () => {
		const db = createTestDb();
		try {
			const first = [
				userMessage("keep", 1),
				assistantMessage("[dropped §2§]", 2),
			];
			stripPiDroppedPlaceholderMessages({
				db,
				sessionId: "ses-placeholders",
				messages: first,
				isCacheBusting: true,
			});

			const replay = [
				userMessage("keep", 1),
				assistantMessage("[dropped §2§]", 2),
				assistantMessage("[dropped §3§]", 3),
			];
			const result = stripPiDroppedPlaceholderMessages({
				db,
				sessionId: "ses-placeholders",
				messages: replay,
				isCacheBusting: false,
			});

			expect(result).toEqual({ removed: 1, discovered: 0 });
			expect(replay).toHaveLength(2);
		} finally {
			closeQuietly(db);
		}
	});

	it("uses the carried-id map by object-ref and survives an index shift", () => {
		const db = createTestDb();
		try {
			// Pass 1: discover under a real entry id carried by object-ref.
			const placeholder = assistantMessage("[dropped §9§]", 2);
			const pass1 = [userMessage("keep", 1), placeholder];
			const map1 = new Map<object, string>([
				[pass1[0] as object, "entry-keep"],
				[placeholder as object, "entry-PH"],
			]);
			const r1 = stripPiDroppedPlaceholderMessages({
				db,
				sessionId: "ses-carry",
				messages: pass1,
				isCacheBusting: true,
				stableIdByRef: map1,
			});
			expect(r1).toEqual({ removed: 1, discovered: 1 });
			// Persisted under the REAL id, not pi-msg-*.
			expect(getStrippedPlaceholderIds(db, "ses-carry").has("entry-PH")).toBe(
				true,
			);

			// Pass 2 (defer): the SAME placeholder object now sits at a DIFFERENT
			// index (prefix grew), and a synthetic m[0] prepend (NOT in the map) is
			// at the head. Removal must still strip the placeholder by object-ref
			// and SKIP the unmapped synthetic prepend.
			const syntheticPrepend = userMessage("<session-history>…", 0);
			const pass2 = [
				syntheticPrepend,
				userMessage("newer", 3),
				userMessage("keep", 1),
				placeholder,
			];
			const map2 = new Map<object, string>([
				[pass2[1] as object, "entry-newer"],
				[pass2[2] as object, "entry-keep"],
				[placeholder as object, "entry-PH"],
				// syntheticPrepend deliberately absent → skip-on-miss.
			]);
			const r2 = stripPiDroppedPlaceholderMessages({
				db,
				sessionId: "ses-carry",
				messages: pass2,
				isCacheBusting: false,
				stableIdByRef: map2,
			});
			expect(r2.removed).toBe(1); // only the placeholder
			expect(pass2).not.toContain(placeholder);
			expect(pass2).toContain(syntheticPrepend); // unmapped → never stripped
		} finally {
			closeQuietly(db);
		}
	});
});
