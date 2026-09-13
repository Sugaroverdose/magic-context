import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pins from "../../src/opencode2-runner/sha256-pins.json";

test("v1_untouched and captured fixture bytes remain sha256 pinned", () => {
	const root = resolve(import.meta.dir, "../../../..");
	for (const [path, expected] of Object.entries(pins)) {
		expect(
			createHash("sha256")
				.update(readFileSync(resolve(root, path)))
				.digest("hex"),
			path,
		).toBe(expected);
	}
});
