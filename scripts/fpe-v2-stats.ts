/**
 * FPE v2 render stats harness — the self-contained tuning instrument for the
 * garbage-by-composition render (gen-1 measured the soup render the same way;
 * the numbers live in docs/research/mc-563-placeholder-design.md).
 *
 * Run: bun scripts/fpe-v2-stats.ts
 * Sections: uniqueness (token + format), density/geometry, NFC stability,
 * per-serve noise-null census, false-positive scans (real-content corpus and
 * legacy-soup FP), timing.
 */
import {
	deriveKey,
	FILLER_POOL,
	fpeDecrypt,
	fpeEncrypt,
	fpeGate,
	fpeGateLegacy,
	isFpeTokenCandidate,
	renderDropToken,
	stripFillers,
} from "../packages/plugin/src/hooks/magic-context/fpe";

const KEY = deriveKey("stats-session");
const N = 4000;

function fmt(name: string, value: string): void {
	console.log(`${name.padEnd(46)} ${value}`);
}

// --- Uniqueness -------------------------------------------------------------
{
	const tokens = new Set<string>();
	const formats = new Set<string>();
	const lens = new Map<number, number>();
	let nfcStable = 0;
	let densityOk = true;
	for (let i = 0; i < N; i++) {
		const t = renderDropToken(i, KEY);
		tokens.add(t);
		formats.add(
			[...t]
				.map((c) => (/[a-z0-9]/.test(c) ? "X" : c.codePointAt(0)!.toString(16)))
				.join(""),
		);
		lens.set(t.length, (lens.get(t.length) ?? 0) + 1);
		if (t.normalize("NFC") === t) nfcStable++;
		const chars = [...t];
		for (let j = 0; j < chars.length - 1; j++) {
			if (/[a-z0-9]/.test(chars[j]) && /[a-z0-9]/.test(chars[j + 1]))
				densityOk = false;
		}
	}
	fmt("token uniqueness", `${tokens.size}/${N}`);
	fmt("format uniqueness (mark types x counts)", `${formats.size}/${N}`);
	fmt(
		"length histogram",
		[...lens.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([l, c]) => `${l}:${c}`)
			.join(" "),
	);
	fmt("NFC-stable renders", `${nfcStable}/${N}`);
	fmt("density: no adjacent payload chars", String(densityOk));
}

// --- Noise-null census (per-serve) -------------------------------------------
// Emulates the imitation act WITHOUT a live model: uniform random emission over
// the token's own character-class neighborhood (alnum + pool marks). Gate
// accepts = the channel an imitator can hit by blind sampling. For the live
// model, the same shape is measured as spontaneous-emission rate in an
// off-topic session (the qualification probe).
{
	const pool = "abcdefghijklmnopqrstuvwxyz0123456789" + FILLER_POOL.join("");
	const maxTag = 30_000;
	let candidates = 0;
	let accepted = 0;
	const TRIALS = 1_000_000;
	for (let i = 0; i < TRIALS; i++) {
		const len = 15 + (i % 8);
		let s = "";
		for (let j = 0; j < len; j++)
			s += pool[Math.floor(Math.random() * pool.length)];
		if (!isFpeTokenCandidate(s)) continue;
		candidates++;
		if (fpeGate(s, KEY, 8, maxTag).matched) accepted++;
	}
	fmt(
		"nullspace scan (1M random same-class strings)",
		`candidates ${candidates}, gate-accepted ${accepted}`,
	);
}

// --- False-positive scans ----------------------------------------------------
{
	const corpus: string[] = [
		"ls -la /tmp",
		"git commit -m 'fix bug'",
		"npm install express",
		"cat /etc/passwd",
		"node --max-old-space-size=4096 .",
		"app.min.js",
		"main.test.ts",
		"vendor.chunk.js",
		"utils.js.map",
		"index.d.ts.map",
		"v1.2.3-beta.json",
		"echo hello world",
		"grep -rn 'pattern' src/",
		"python3 script.py --flag",
		"curl https://example.com/api",
		"SELECT a, b FROM t WHERE x = 1",
		"合并两个分支并解决冲突",
		"перезапустить сервис на проде",
		"package.json:12:34",
		"src/features/magic-context/storage-db.ts",
		"npm run test -- --filter fpe",
		"a·b·c·d·e·f·g",
		"9•⸱66•⸱4586‣‣5",
		"dd gsza9s",
		"6d5⸱u·1  ask",
		"bun test src/hooks/magic-context/fpe.test.ts",
	];
	const fp: string[] = [];
	const legacyHit: string[] = [];
	for (const s of corpus) {
		if (fpeGate(s, KEY, 8, 30_000).matched) fp.push(s);
		const legacy = fpeGateLegacy(s, KEY, 8, 30_000);
		if (legacy.status !== "none") legacyHit.push(`${s} -> ${legacy.status}`);
	}
	fmt(
		`v2 gate FP over ${corpus.length} real-content strings`,
		String(fp.length),
	);
	fmt(
		"legacy lane hits (retired-format strings)",
		legacyHit.join(" | ") || "none",
	);
}

// --- Timing --------------------------------------------------------------
{
	const bench = (name: string, ops: number, fn: (i: number) => void): void => {
		for (let i = 0; i < 2000; i++) fn(i);
		const t0 = performance.now();
		for (let i = 0; i < ops; i++) fn(i);
		const dt = performance.now() - t0;
		fmt(name, `${((dt * 1e6) / ops).toFixed(2)} ns/op`);
	};
	bench("encrypt (L=8)", 200_000, (i) => fpeEncrypt(i % 9_900_000, KEY, 8));
	bench("decrypt (L=8)", 200_000, (i) =>
		fpeDecrypt(fpeEncrypt(i % 9_900_000, KEY, 8), KEY, 8),
	);
	bench("transform (encrypt + fillers)", 200_000, (i) =>
		renderDropToken(i % 9_900_000, KEY),
	);
	const valid = renderDropToken(42, KEY);
	bench("gate: valid token", 500_000, () => fpeGate(valid, KEY, 8, 30_000));
	bench("gate: 100% reject", 500_000, (i) =>
		fpeGate(`ls -la /tmp/${i % 1000}`, KEY, 8, 30_000),
	);
}
