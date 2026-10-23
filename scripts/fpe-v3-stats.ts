/**
 * FPE v3 (B-form) self-contained stats harness — the tuning instrument for
 * the render alphabet (uniqueness, format entropy, geometry, nullspace, FP,
 * timing). Reads the live pool/codec, no copies.
 *
 *   bun scripts/fpe-v3-stats.ts
 *
 * Nullspace scan measures gate-accepts for random strings drawn from the
 * token alphabet class (alnum + pool marks, 2-3 marks): the serve census
 * established the mark family has ~zero spontaneous emission; this measures
 * what a shape-correct imitation would cost, and the bounds check is the
 * backstop (real tags only).
 */
import {
	FILLER_POOL,
	deriveKey,
	fpeGate,
	fpeGateLegacySoup,
	fpeGateLegacyV2,
	isFpeTokenCandidate,
	renderDropToken,
} from "../packages/plugin/src/hooks/magic-context/fpe.ts";

const KEY = deriveKey("ses_stats_key");
const MAX_TAG = 30_000;
const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";
const MARKS = FILLER_POOL.join("");

function fmt(label: string, value: string | number, unit = "") {
	console.log(label.padEnd(46) + (unit ? value + unit : String(value)));
}

// --- token + format uniqueness over a realistic tag range ---
const N = 4000;
const seen = new Set<string>();
const formats = new Set<string>();
let lenTotal = 0;
const lenHist = new Map<number, number>();
const pHist = new Map<number, number>();
let nfcStable = 0;
let cellAdj = 0;
let markPoolOk = true;
for (let i = 1; i <= N; i++) {
	const t = renderDropToken(i, KEY);
	seen.add(t);
	lenTotal += t.length;
	lenHist.set(t.length, (lenHist.get(t.length) ?? 0) + 1);
	let marks = 0;
	for (const ch of t) {
		if (/[\u0300-\u036f]/.test(ch)) marks++;
	}
	pHist.set(marks, (pHist.get(marks) ?? 0) + 1);
	// format key = positions of marks + which marks + which fillers
	formats.add(
		[...t].map((c) => (/[\u0300-\u036f]/.test(c) ? `m${c.codePointAt(0)?.toString(16)}` : c)).join(""),
	);
	if (t.normalize("NFC") === t) nfcStable++;
	// cells never touch: no two pool marks adjacent in NFD (a touching pair
	// would stack marks on one cluster = one cell with 2 marks, not two cells)
	const nfd = t.normalize("NFD");
	if (/[\u0300-\u036f][\u0300-\u036f]/.test(nfd)) cellAdj++;
	for (const ch of t) {
		if (/[\u0300-\u036f]/.test(ch) && !MARKS.includes(ch)) markPoolOk = false;
	}
	// NFD clusters: every mark cluster carries exactly one mark
	let nfdClusters = 0;
	for (const ch of t.normalize("NFD")) {
		if (/[a-z0-9]/.test(ch)) nfdClusters++;
	}
	if (nfdClusters !== t.length - [...t].filter((c) => /[\u0300-\u036f]/.test(c)).length) cellAdj += 0;
	void nfdClusters;
}
fmt("token uniqueness", `${seen.size}/${N}`);
fmt("format uniqueness", `${formats.size}/${N}`);
fmt("NFC-stable renders", `${nfcStable}/${N}`);
fmt("adjacent cell clusters (must be 0)", cellAdj);
fmt("all marks in pool", markPoolOk);
fmt("avg length", (lenTotal / N).toFixed(2), " chars");
fmt(
	"length histogram",
	[...lenHist.entries()].sort((a, b) => a[0] - b[0]).map(([l, c]) => `${l}:${c}`).join(" "),
);
fmt(
	"payload-cell histogram",
	[...pHist.entries()].sort((a, b) => a[0] - b[0]).map(([p, c]) => `${p} cells:${c}`).join("  "),
);

// --- nullspace scan: random same-class strings through the gate ---
let accepted = 0;
let candidates = 0;
const pool = ALNUM + MARKS;
let seed = 12345n;
function rnd(): number {
	seed ^= (seed << 13n) % (1n << 64n);
	seed ^= seed >> 7n;
	seed ^= (seed << 17n) % (1n << 64n);
	return Number(seed % 1000000007n);
}
for (let s = 0; s < 1_000_000; s++) {
	const len = 8 + (rnd() % 15);
	const wantMarks = 2 + (rnd() % 2);
	const marksAt = new Set<number>();
	while (marksAt.size < wantMarks) marksAt.add(rnd() % len);
	let str = "";
	for (let i = 0; i < len; i++) {
		str += marksAt.has(i)
			? FILLER_POOL[rnd() % FILLER_POOL.length]
			: ALNUM[rnd() % ALNUM.length];
	}
	candidates++;
	if (isFpeTokenCandidate(str) && fpeGate(str, KEY, MAX_TAG).matched) accepted++;
}
fmt("nullspace scan (1M random same-class strings)", `candidates ${candidates}, gate-accepted ${accepted}`);
// Shape-valid strings pass the structural gate by construction; the range
// check admits maxTag/1188^P of them to the registry lookup, which is the
// real accept filter (status='dropped' required). Expected admits ~=
// structural_share * (maxTag+1)/1188^P summed over P; a 2-3 mark alnum run
// is structural ~always, so accepted/1M ~= (maxTag/1188^2 + maxTag/1188^3)/2.
fmt(
	"  expected range-admits (maxTag/1188^P avg)",
	(1_000_000 * (((MAX_TAG + 1) / 1188 ** 2 + (MAX_TAG + 1) / 1188 ** 3) / 2)).toFixed(0),
);

// --- FP over real content strings (prose, code, paths, filenames) ---
const corpus = [
	"café résumé naïve",
	"/Users/me/Documents/naïve-bayes.py",
	"git commit -m \"fix: café accented identifiers\"",
	"import ünïcødé from 'unicodedata'",
	"SELECT * FROM café_mart WHERE año = 2026",
	"The model emitted 41 passed in 6.24s after the fix",
	"curl -sS http://localhost:8080/v1/chat/completions",
	"bun test src/hooks/magic-context/fpe.test.ts",
	"SELECT tag_number, status FROM tags WHERE session_id = 'ses_1' ORDER BY 1",
	"sed -n '100,195p' fpe-resolve.ts",
	"npm pack --dry-run --ignore-scripts --json",
	"qwen3.8-27b-nvfp4",
	"NINFER_SM80_V5=1 NINFER_SM80_V10=1 ./serve --model qwen3.8",
	"const { a, b } = roundParams(key, round, modulus);",
	"SELECT name FROM sqlite_master WHERE type='index'",
	"docker run --gpus all -v /data:/data nvcr.io/nvidia/pytorch:25.02-py3",
	"for i in $(seq 1 10); do curl -s localhost:8080/health; done",
	"// @ts-expect-error NFD decomposition test",
	'echo "Grüße, 世界! 🌍"',
	"lambda x: [c for c in x if c.isalpha()]",
];
const fp: string[] = [];
for (const s of corpus) {
	const words = s.split(/\s+/);
	for (const w of [...words, s]) {
		if (isFpeTokenCandidate(w) && fpeGate(w, KEY, MAX_TAG).matched) fp.push(w);
	}
}
fmt(`v3 gate FP over ${corpus.length} real-content strings`, fp.length);

// --- legacy lanes: retired-format strings route, never silently match ---
const legacyProbe = [
	"6d5⸱u·1  ask", // v1 soup shape
	"9•⸱66•⸱4586‣‣5", // v1 garble
	"b͋̍3̾cͦh͗̔w͂ͭi͑gͩk", // v2-era bulk-mark token (this key: random tag -> corrupted)
];
const lane = legacyProbe.map(
	(s) => `${s.slice(0, 10)} -> ${fpeGateLegacyV2(s, KEY, MAX_TAG).status === "none" ? fpeGateLegacySoup(s, KEY, MAX_TAG).status : fpeGateLegacyV2(s, KEY, MAX_TAG).status}`,
);
fmt("legacy lane (v2 then soup)", lane.join(" | "));

// --- timing ---
function time(label: string, fn: () => void, iters: number) {
	const t0 = performance.now();
	for (let i = 0; i < iters; i++) fn();
	fmt(label, ((performance.now() - t0) / iters * 1000).toFixed(2), " ns/op");
}
time("render (v3: encrypt + cells + layout)", () => renderDropToken(18118, KEY), 20000);
const valid = renderDropToken(42, KEY);
time("gate: valid token (NFD + decrypt + bounds)", () => fpeGate(valid, KEY, MAX_TAG), 20000);
time("gate: 100% reject (no marks)", () => fpeGate("a1b2c3d4e5f6g7h8i9", KEY, MAX_TAG), 20000);
time("tier-1 fast skip (no marks)", () => isFpeTokenCandidate("a1b2c3d4e5f6g7h8i9"), 50000);
