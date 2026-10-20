import { createHash } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const BASE = 36n;
const FILLER_POOL = [
    "\u00b7",
    "\u2219",
    "\u2e31",
    "\u2023",
    "\u2022",
    "\u2248",
    "\u2212",
    "\u2605",
    "\u2717",
    "\u2032",
];
const SPACE_MARK = "\u0020";
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
            const count = pct < 50 ? 0 : pct < 80 ? 1 : 2;
            for (let j = 0; j < count; j++) {
                const [fp, ns] = xorshift64(state);
                state = ns;
                result += FILLER_POOL[fp % FILLER_POOL.length];
            }
        }
    }
    return result;
}

export function addChannelMarks(filled: string, key: bigint): string {
    const seed = fnv1a(filled + "sp" + key.toString(16));
    let state = seed;
    const positions: number[] = [];
    for (let d = 0; d < 2; d++) {
        const [pres, n1] = xorshift64(state);
        state = n1;
        if (pres < 50) {
            const [p, n2] = xorshift64(state);
            state = n2;
            positions.push((p % Math.max(filled.length - 1, 1)) + 1);
        }
    }
    positions.sort((a, b) => b - a);
    let out = filled;
    for (const p of positions) out = out.slice(0, p) + SPACE_MARK + out.slice(p);
    return out;
}

export function stripFillers(token: string): string {
    return token.replace(/[^a-z0-9]/g, "");
}

export function renderDropToken(tagId: number, key: bigint): string {
    const length = tagId < 10_000_000 ? L_FLOOR : 9;
    const encrypted = fpeEncrypt(tagId, key, length);
    return addChannelMarks(addFillers(encrypted, key), key);
}

export interface FpeGateResult {
    matched: boolean;
    tagId?: number;
}

export function fpeGate(value: string, key: bigint, currentL: number): FpeGateResult {
    if (value.length < L_FLOOR || value.length > L_FLOOR + 16) {
        return { matched: false };
    }
    const hasNonAlnum = /[^a-z0-9]/.test(value);
    if (!hasNonAlnum) return { matched: false };
    const fillerChars = value.replace(/[a-z0-9]/g, "");
    for (const c of fillerChars) {
        if (!FILLER_POOL.includes(c) && c !== SPACE_MARK) return { matched: false };
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
    if (tagId < 0 || tagId >= BASE ** BigInt(len)) {
        return { matched: false };
    }
    return { matched: true, tagId };
}

export function isFpeTokenCandidate(value: string): boolean {
    if (value.length < L_FLOOR || value.length > L_FLOOR + 16) return false;
    if (!/[^a-z0-9]/.test(value)) return false;
    const stripped = stripFillers(value);
    if (stripped.length < L_FLOOR - 1 || stripped.length > 10) return false;
    return /^[a-z0-9]+$/.test(stripped);
}
