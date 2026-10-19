import { createHash } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const BASE = 36n;
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
/** v1 (retired) drop-token fillers — used only by the legacy resolution lane. */
const LEGACY_FILLER_POOL = ["·", "∙", "⸱", "‣", "•", " "];
const LEGACY_FILLER_SET = new Set(LEGACY_FILLER_POOL);
const ROUNDS = 16;
const L_FLOOR = 8;

function strToBigint(s: string): bigint {
    let n = 0n;
    for (const c of s) {
        n = n * BASE + BigInt(ALPHABET.indexOf(c));
    }
    return n;
}

function bigintToStr(n: bigint, length: number): string {
    let s = "";
    for (let i = 0; i < length; i++) {
        s = ALPHABET[Number(n % BASE)] + s;
        n /= BASE;
    }
    return s;
}

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

function roundParams(key: bigint, round: number, modulus: bigint): { a: bigint; b: bigint } {
    const k = (key + BigInt(round * 8)) % modulus;
    let a = (k % (modulus - 1n)) + 1n;
    if (a % 2n === 0n) a += 1n;
    if (a % 3n === 0n) a += 2n;
    if (a >= modulus) a -= modulus;
    const b = k % modulus;
    return { a, b };
}

export function fpeEncrypt(tagId: number, key: bigint, length: number): string {
    const modulus = BASE ** BigInt(length);
    let value = BigInt(tagId);
    for (let round = 0; round < ROUNDS; round++) {
        const { a, b } = roundParams(key, round, modulus);
        value = (value * a + b) % modulus;
    }
    return bigintToStr(value, length);
}

export function fpeDecrypt(token: string, key: bigint, length: number): number {
    const modulus = BASE ** BigInt(length);
    let value = strToBigint(token);
    for (let round = ROUNDS - 1; round >= 0; round--) {
        const { a, b } = roundParams(key, round, modulus);
        const aInv = modInverse(a, modulus);
        value = (((value - b + modulus) % modulus) * aInv) % modulus;
    }
    return Number(value);
}

function fnv1a(s: string): bigint {
    let hash = 0xcbf29ce484222325n;
    for (let i = 0; i < s.length; i++) {
        hash ^= BigInt(s.charCodeAt(i));
        hash = (hash * 0x100000001b3n) % (1n << 64n);
    }
    return hash;
}

function xorshift64(state: bigint): [number, bigint] {
    let s = state;
    s ^= (s << 13n) % (1n << 64n);
    s ^= s >> 7n;
    s ^= (s << 17n) % (1n << 64n);
    return [Number(s % 100n), s];
}

export function addFillers(token: string, key: bigint): string {
    const seed = fnv1a(token + key.toString(16));
    let state = seed;
    let result = "";
    for (let i = 0; i < token.length; i++) {
        result += token[i];
        if (i < token.length - 1) {
            const [pct, nextState] = xorshift64(state);
            state = nextState;
            // v2 density: every gap carries at least one mark — the line
            // breaks at every payload character; no readable runs form.
            const count = pct < 60 ? 1 : 2;
            for (let j = 0; j < count; j++) {
                const [fp, ns] = xorshift64(state);
                state = ns;
                result += FILLER_POOL[fp % FILLER_POOL.length];
            }
        }
    }
    return result;
}

export function stripFillers(token: string): string {
    return token.replace(/[^a-z0-9]/g, "");
}

export function renderDropToken(tagId: number, key: bigint): string {
    const length = tagId < 10_000_000 ? L_FLOOR : 9;
    const encrypted = fpeEncrypt(tagId, key, length);
    return addFillers(encrypted, key);
}

export interface FpeGateResult {
    matched: boolean;
    tagId?: number;
}

/**
 * Accept requires `tagId` to be a real released tag of the session
 * (`0 <= tagId <= maxTag`, status check lives in the lookup). The v1 accept
 * test `tagId < BASE ** len` ranged over the ENCODING space, not over real
 * tags: every 8-char base36 string decrypted "successfully" (the Feistel is
 * a bijection), so the gate policed obscurity of a format the wire publishes
 * on every release, and a shape-only imitation entered silently.
 */
export function fpeGate(
    value: string,
    key: bigint,
    currentL: number,
    maxTag: number,
): FpeGateResult {
    if (value.length < L_FLOOR || value.length > L_FLOOR + 14) {
        return { matched: false };
    }
    const hasNonAlnum = /[^a-z0-9]/.test(value);
    if (!hasNonAlnum) return { matched: false };
    const fillerChars = value.replace(/[a-z0-9]/g, "");
    for (const c of fillerChars) {
        if (!FILLER_SET.has(c)) return { matched: false };
    }
    const stripped = stripFillers(value);
    const len = stripped.length;
    if (len !== currentL && len !== currentL - 1) {
        return { matched: false };
    }
    if (!/^[a-z0-9]+$/.test(stripped)) {
        return { matched: false };
    }
    const tagId = fpeDecrypt(stripped, key, len);
    if (tagId < 0 || tagId > maxTag) {
        return { matched: false };
    }
    return { matched: true, tagId };
}

/** Legacy (v1) drop-token shape: soup payload + dot fillers, no marks. */
export function isLegacySoupCandidate(value: string): boolean {
    if (value.length < L_FLOOR || value.length > L_FLOOR + 14) return false;
    if (!/[^a-z0-9]/.test(value)) return false;
    const stripped = stripFillers(value);
    if (stripped.length < L_FLOOR - 1 || stripped.length > 10) return false;
    if (!/^[a-z0-9]+$/.test(stripped)) return false;
    for (const c of value) {
        if (/[a-z0-9]/.test(c)) continue;
        if (!LEGACY_FILLER_SET.has(c)) return false;
    }
    return true;
}

export type FpeLegacyGateResult =
    | { status: "resolved"; tagId: number }
    | { status: "corrupted" }
    | { status: "none" };

/**
 * Legacy lane: this build renders v2 tokens only, so a v1-shaped string is
 * either a pre-upgrade release replay (decrypts to a real tag of this session
 * — resolve it) or a corrupted token (out of range — the model's own noise
 * shaped like our retired format; the original cannot be restored from it).
 */
export function fpeGateLegacy(
    value: string,
    key: bigint,
    currentL: number,
    maxTag: number,
): FpeLegacyGateResult {
    if (!isLegacySoupCandidate(value)) return { status: "none" };
    const stripped = stripFillers(value);
    const len = stripped.length;
    if (len !== currentL && len !== currentL - 1) return { status: "none" };
    const tagId = fpeDecrypt(stripped, key, len);
    if (tagId >= 0 && tagId <= maxTag) return { status: "resolved", tagId };
    return { status: "corrupted" };
}

export function isFpeTokenCandidate(value: string): boolean {
    if (value.length < L_FLOOR || value.length > L_FLOOR + 14) return false;
    if (!/[^a-z0-9]/.test(value)) return false;
    const stripped = stripFillers(value);
    if (stripped.length < L_FLOOR - 1 || stripped.length > 10) return false;
    return /^[a-z0-9]+$/.test(stripped);
}
