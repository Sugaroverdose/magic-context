/**
 * Pin the OpenCode-1 host binary by committed hash — the oracle-lane analogue of
 * the OC2 lane's sha256-pins.json. The oracle compares wire bytes across boots,
 * so the host that renders them must be identical; a drifting `brew upgrade` must
 * fail the run BEFORE any spawn, never as a mid-test diff.
 */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

interface OpenCode1Pin {
	version: string;
	sha256: string;
}

const PIN_PATH = resolve(import.meta.dir, "../..", "opencode-runner", "opencode1-sha256-pins.json");

export function loadOpenCode1Pins(): Record<string, OpenCode1Pin> {
	return JSON.parse(readFileSync(PIN_PATH, "utf8")) as Record<string, OpenCode1Pin>;
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export interface ResolvedOpenCode1Host {
	/** The PATH-resolved `opencode` binary the runner's bare "opencode" spawn executes. */
	binary: string;
	/** The symlink target that was hashed. */
	realBinary: string;
	sha256: string;
	pinVersion: string;
}

/**
 * Resolve the OC1 host and check its sha256 against the committed pin. Throws
 * before any spawn on a missing binary or a hash mismatch whose message names
 * this pin file and the offending hash.
 */
export function resolvePinnedOpenCode1Host(): ResolvedOpenCode1Host {
	const binary = Bun.which("opencode");
	if (!binary) {
		throw new Error("oracle OC1 leg: `opencode` not found on PATH — cannot boot the OC1 leg");
	}
	const realBinary = realpathSync(binary);
	const sha256 = sha256File(realBinary);
	const pin = loadOpenCode1Pins()["opencode1-host"];
	if (!pin) throw new Error(`oracle OC1 leg: pin file ${PIN_PATH} has no "opencode1-host" entry`);
	if (pin.sha256 !== sha256) {
		throw new Error(
			`opencode1-sha256-pins.json: OC1 host binary hash mismatch — expected ${pin.sha256}, ` +
				`found ${sha256} for ${realBinary}. The host that renders the oracle wire drifted; ` +
				"update the committed pin only with the owner's field-verified version.",
		);
	}
	return { binary, realBinary, sha256, pinVersion: pin.version };
}
