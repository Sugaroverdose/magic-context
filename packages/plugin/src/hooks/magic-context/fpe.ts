import { createHash } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
/**
 * v2 filler alphabet: combining diacritical marks (U+0300–U+036F), restricted
 * to canonical class 230 (above, nonspacing — runs of one class never
 * canonical-reorder, so the render is NFC-byte-stable) and to marks with no
 * canonical-composition pair against a payload character (the composed form
 * would swallow it). Decode is strip; normalization is identity.
 *
 * The family is chosen per serve census, not taste: the model's spontaneous
 * byte-noise concentrates in the typographic/mojibake families (U+20, U+22,
 * U+2E, U+00 — v1's dot filler pool sat exactly there, which is why garbles
 * self-assembled in token shape), while the mark block measured zero
 * spontaneous emissions in 100M tokens on the quantized serve. Imitation needs
 * a generative channel into the filler class; the census says there is none.
 */
const FILLER_CODEPOINTS = [
    0x0305, 0x030d, 0x030e, 0x0310, 0x0312, 0x0313, 0x0314, 0x033d, 0x033e, 0x033f, 0x0342, 0x0346,
    0x034a, 0x034b, 0x034c, 0x0350, 0x0351, 0x0352, 0x0357, 0x035b, 0x0363, 0x0364, 0x0365, 0x0366,
    0x0367, 0x0368, 0x0369, 0x036a, 0x036b, 0x036c, 0x036d, 0x036e, 0x036f,
];
export const FILLER_POOL = FILLER_CODEPOINTS.map((cp) => String.fromCodePoint(cp));
const FILLER_SET = new Set(FILLER_POOL);
const ROUNDS = 16;

export function deriveKey(sessionId: string): bigint {
    const hash = createHash("sha256").update(sessionId).digest();
    let key = 0n;
    for (let i = 0; i < 32; i++) {
        key = (key << 8n) | BigInt(hash[i]);
    }
    return key;
}

function modInverse(a: bigint, m: bigint): bigint {
    let [old_r, r] = [a % m, m];
    let [old_s, s] = [1n, 0n];
    while (r !== 0n) {
        const q = old_r / r;
        [old_r, r] = [r, old_r - q * r];
        [old_s, s] = [s, old_s - q * s];
    }
    return ((old_s % m) + m) % m;
}

function gcd(a: bigint, b: bigint): bigint {
    let [x, y] = [a < 0n ? -a : a, b < 0n ? -b : b];
    while (y !== 0n) {
        [x, y] = [y, x % y];
    }
    return x;
}

function roundParams(key: bigint, round: number, modulus: bigint): { a: bigint; b: bigint } {
    const k = (key + BigInt(round * 8)) % modulus;
    let a = (k % (modulus - 1n)) + 1n;
    if (a % 2n === 0n) a += 1n;
    if (a % 3n === 0n) a += 2n;
    if (a >= modulus) a -= modulus;
    // Coprimality against every modulus factor (the 2/3 checks above are
    // sized for base-36 moduli; the cell radix 1188 = 2^2 * 3^3 * 11 adds
    // factor 11). For moduli with only factors 2 and 3 the chain above
    // already yields gcd(a, m) = 1, so the loop never runs — legacy
    // (base-36) decryption is unchanged.
    while (gcd(a, modulus) !== 1n) {
        a += 2n;
        if (a >= modulus) a -= modulus;
    }
    const b = k % modulus;
    return { a, b };
}

function fnv1a(s: string): bigint {
    let hash = 0xcbf29ce484222325n;
    for (let i = 0; i < s.length; i++) {
        hash ^= BigInt(s.charCodeAt(i));
        hash = (hash * 0x100000001b3n) % (1n << 64n);
    }
    return hash;
}

function nextU64(state: bigint): bigint {
    let s = state;
    s ^= (s << 13n) % (1n << 64n);
    s ^= s >> 7n;
    s ^= (s << 17n) % (1n << 64n);
    return s;
}

/**
 * v3 (B-form) render: the PAYLOAD rides the mark cells — the census-null class
 * — and the bulk rides cheap alnum fillers. v2 (marks as fillers throughout)
 * measured ~27 serve tokens per carrier because every mark byte-fallbacks; B
 * pays that price for exactly P cells (2 or 3) instead of ~10.
 *
 * Cell = one base char (a-z0-9) + exactly one pool mark, 1188 cells.
 * Payload = P cells, a bijection over 1188^P (P=2: 704K tags; P=3: 1.67G).
 * P and the cell positions are seeded from the encrypted payload + key:
 * pseudo-random, deterministic (same tag + session => same bytes forever —
 * no cache-bust on restart). Cells never touch each other (a filler between
 * every cell), so every mark cluster is exactly one cell: extraction is a
 * single NFD pass with no grapheme-boundary guessing.
 */
const CELL_BASES = ALPHABET; // 36
const CELL_RADIX = BigInt(CELL_BASES.length * FILLER_POOL.length); // 1188
const P2_MAX_TAG = Number(CELL_RADIX ** 2n) - 1; // 1_411_183
export const V3_LEN_FLOOR = 8;
export const V3_LEN_CEIL = 22;

function cellsToString(value: bigint, p: number): string {
    let out = "";
    let n = value;
    for (let i = 0; i < p; i++) {
        const cell = Number(n % CELL_RADIX);
        n /= CELL_RADIX;
        out =
            CELL_BASES[Math.floor(cell / FILLER_POOL.length)] +
            FILLER_POOL[cell % FILLER_POOL.length] +
            out;
    }
    return out;
}

function cellFromString(base: string, mark: string): number {
    const b = CELL_BASES.indexOf(base);
    const m = FILLER_POOL.indexOf(mark);
    if (b < 0 || m < 0) return -1;
    return b * FILLER_POOL.length + m;
}

function encryptCellSpace(tagId: number, key: bigint, p: number): bigint {
    const modulus = CELL_RADIX ** BigInt(p);
    let value = BigInt(tagId);
    for (let round = 0; round < ROUNDS; round++) {
        const { a, b } = roundParams(key, round, modulus);
        value = (value * a + b) % modulus;
    }
    return value;
}

function decryptCellSpace(cells: number[], key: bigint, p: number): number {
    const modulus = CELL_RADIX ** BigInt(p);
    let value = 0n;
    for (const c of cells) value = value * CELL_RADIX + BigInt(c);
    for (let round = ROUNDS - 1; round >= 0; round--) {
        const { a, b } = roundParams(key, round, modulus);
        const aInv = modInverse(a, modulus);
        value = (((value - b + modulus) % modulus) * aInv) % modulus;
    }
    return Number(value);
}

function chooseP(tagId: number, seed: bigint): 2 | 3 {
    if (tagId > P2_MAX_TAG) return 3;
    return seed & 1n ? 2 : 3;
}

export function renderDropToken(tagId: number, key: bigint): string {
    const plain = BigInt(tagId);
    const probe = encryptCellSpace(tagId, key, 2);
    const seed = fnv1a(probe.toString(36) + key.toString(16));
    const p = chooseP(tagId, seed);
    const encrypted = p === 2 ? probe : encryptCellSpace(tagId, key, 3);
    const payload = cellsToString(encrypted, p);

    // Layout: F filler slots + P cell slots, cells at seeded non-adjacent
    // positions (Fisher-Yates on cell slots, seeded). Deterministic from the
    // payload + key; nothing else can move them.
    let state = seed;
    let f = 10 + Number(seed % 5n); // 10..14 fillers => len 14..20
    const slots = f + p;
    const cellAt = new Set<number>();
    while (cellAt.size < p) {
        state = nextU64(state);
        const pos = Number(state % BigInt(slots));
        let ok = true;
        for (const used of cellAt) {
            if (Math.abs(used - pos) < 2) {
                ok = false;
                break;
            }
        }
        if (ok) cellAt.add(pos);
    }
    let out = "";
    for (let i = 0, c = 0; i < slots; i++) {
        if (cellAt.has(i)) {
            // one cell = 2 code units
            out += payload[c * 2] + payload[c * 2 + 1];
            c++;
        } else {
            state = nextU64(state);
            out += CELL_BASES[Number(state % BigInt(CELL_BASES.length))];
        }
    }
    return out;
}

export interface FpeGateResult {
    matched: boolean;
    tagId?: number;
}

/**
 * Split into clusters: (base, marks[]) over NFD codepoints. Returns null on
 * any non-pool mark (cheap reject).
 */
function extractClusters(
    value: string,
): Array<{ base: string; marks: string[] }> | null {
    const clusters: Array<{ base: string; marks: string[] }> = [];
    let current: { base: string; marks: string[] } | null = null;
    for (const ch of value.normalize("NFD")) {
        if (/[a-z0-9]/.test(ch)) {
            current = { base: ch, marks: [] };
            clusters.push(current);
        } else if (/[\u0300-\u036f]/.test(ch)) {
            if (!FILLER_SET.has(ch)) return null;
            if (!current) return null; // leading orphan mark
            current.marks.push(ch);
        } else {
            return null; // any other codepoint: not a token
        }
    }
    return clusters;
}

/**
 * v3 gate. Structural accept surface: every codepoint is a pool mark or an
 * alnum base; exactly P clusters carry exactly one mark each; those cells are
 * pairwise separated (>=1 alnum between); then the P-cell Feistel must land
 * inside [0, maxTag] — the v1 lesson: acceptance ranges over REAL tags, never
 * over the encoding space (the cipher is a bijection; a range over the cipher
 * domain accepts every shape-valid string).
 */
export function fpeGate(value: string, key: bigint, maxTag: number): FpeGateResult {
    if (value.length < V3_LEN_FLOOR || value.length > V3_LEN_CEIL) {
        return { matched: false };
    }
    const clusters = extractClusters(value);
    if (!clusters) return { matched: false };
    const cells: number[] = [];
    const cellIdx: number[] = [];
    for (let i = 0; i < clusters.length; i++) {
        const { base, marks } = clusters[i];
        if (marks.length === 0) continue;
        if (marks.length > 1) return { matched: false };
        const cell = cellFromString(base, marks[0]);
        if (cell < 0) return { matched: false };
        cells.push(cell);
        cellIdx.push(i);
    }
    const p = cells.length;
    if (p !== 2 && p !== 3) return { matched: false };
    for (let i = 1; i < cellIdx.length; i++) {
        if (cellIdx[i] - cellIdx[i - 1] < 2) return { matched: false };
    }
    const tagId = decryptCellSpace(cells, key, p);
    if (tagId < 0 || tagId > maxTag) return { matched: false };
    return { matched: true, tagId };
}

export function isFpeTokenCandidate(value: string): boolean {
    if (value.length < V3_LEN_FLOOR || value.length > V3_LEN_CEIL) return false;
    if (!/[\u0300-\u036f]/.test(value)) return false;
    let marks = 0;
    for (const ch of value) {
        if (/[\u0300-\u036f]/.test(ch)) marks++;
        else if (!/[a-z0-9]/.test(ch)) return false;
    }
    return marks === 2 || marks === 3;
}
