import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

// Stage R2 (design §24): the Rust module keeps heads (§9's full migration is
// gated on subc enablement; the region stays off the Rust lane, pinned by
// the C2 spy law and the boot predicate). What must nevertheless hold — and
// what these laws pin — is SERVE + REFUSAL PARITY: the module never reads
// the shared region column (no double baseline can be manufactured by the
// module serving region bytes as head text), carries zero region vocabulary
// (L0: no writer, no reader, no sentinel), and its store-repair resets the
// region row exactly like the host's receipted clear resets head state.

const REPO = join(import.meta.dir, "..", "..", "..", "..", "..");
const CRATES = join(REPO, "crates");
// Review F5: every crate's production tree is in scope — a future reader
// appearing in mc-core or mc-tokenizer reddens the same way as one in the
// module. Crates are enumerated, not hardcoded, so a new crate is scanned
// from the day it exists; `crates/*/tests/` (integration tests) are out of
// production scope by construction (root is */src).
const RUST_PROD_ROOTS = readdirSync(CRATES)
    .filter((name) => statSync(join(CRATES, name)).isDirectory())
    .map((name) => join(CRATES, name, "src"))
    .filter((dir) => existsSync(dir));

function walkRs(dir: string): Array<{ rel: string; full: string }> {
    const out: Array<{ rel: string; full: string }> = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            if (entry !== "target") out.push(...walkRs(full));
            continue;
        }
        if (!entry.endsWith(".rs")) continue;
        // Suffix/dir exclusion like the TS census's *.test.ts. Honest
        // boundary: inline `#[cfg(test)] mod tests` in a production file is
        // IN scope — a future test read must live in `*_tests.rs` or
        // `crates/*/tests/`, not beside production readers.
        if (entry.endsWith("_tests.rs")) continue;
        out.push({ rel: relative(CRATES, full), full });
    }
    return out;
}

const REGION_VOCABULARY = [
    "mc:system-region",
    "SYSTEM_REGION",
    "decodeSystemRegion",
    "executeSystemRegionRotation",
    "writeSystemRegion",
    "clearSystemRegion",
    "readSystemRegion",
];

// G3 (round 2): the enumeration + existsSync filter above can silently
// zero a zone (a renamed/removed crate src just vanishes from the walk and
// every law still sees "no offenders"). The census therefore declares its
// canonical zone set and the zone-floor law asserts every member is
// present, in the walk roots, and yields production files — a missing zone
// fails with its name, not with a green empty scan.
const CANONICAL_RUST_ZONES = ["mc-core/src", "mc-module/src", "mc-store/src", "mc-tokenizer/src"];

function rustZoneScan(
    roots: string[] = RUST_PROD_ROOTS,
    exists: (p: string) => boolean = existsSync,
) {
    const issues: string[] = [];
    const counts: Array<{ zone: string; files: number }> = [];
    for (const zone of CANONICAL_RUST_ZONES) {
        const dir = join(CRATES, zone);
        if (!roots.includes(dir)) {
            issues.push(`zone ${zone}: absent from the walk roots`);
            continue;
        }
        if (!exists(dir)) {
            issues.push(`zone ${zone}: directory missing on disk`);
            continue;
        }
        const files = walkRs(dir).length;
        if (files === 0) issues.push(`zone ${zone}: walked 0 production files`);
        counts.push({ zone, files });
    }
    return { issues, counts };
}

function rustRefusalOffenders(roots: string[] = RUST_PROD_ROOTS): string[] {
    const offenders: string[] = [];
    for (const { rel, full } of roots.flatMap(walkRs)) {
        const text = readFileSync(full, "utf8");
        if (text.includes("cached_m0_bytes") && rel !== "mc-module/src/single_store_repair.rs") {
            // The adjudicated reset list is the ONE named member (L0 audit,
            // §20): repair erases the column; nothing else in the module
            // touches it. A SELECT here is the double-baseline class.
            offenders.push(`${rel}: cached_m0_bytes`);
        }
        for (const token of REGION_VOCABULARY) {
            if (text.includes(token)) offenders.push(`${rel}: ${token}`);
        }
    }
    return offenders;
}

describe("Rust lane serve+refusal parity (stage R2, §24)", () => {
    it("every canonical crate zone is present, walked, and non-empty (G3)", () => {
        // Silent-zeroing defense: the existsSync-filtered enumeration can
        // drop a whole crate from the walk while every law stays green. The
        // floor names the zone and records the walked count per zone.
        const { issues, counts } = rustZoneScan();
        expect(counts.map((c) => `${c.zone}=${c.files}`).join(", ")).not.toBe("");
        expect(issues).toEqual([]);
    });

    it("control: a mutated root list that drops a zone reddens the floor with the zone named (G3)", () => {
        // In-memory mutation only — no production tree is renamed or moved.
        const mutated = RUST_PROD_ROOTS.filter((r) => !r.endsWith(join("mc-store", "src")));
        const { issues } = rustZoneScan(mutated);
        expect(issues.some((i) => i.includes("mc-store/src") && i.includes("absent"))).toBe(true);
        // A zone present in roots but missing on disk is named too —
        // in-memory disk-view mutation (no production tree is touched).
        const blind = rustZoneScan(
            RUST_PROD_ROOTS,
            (p) => !p.endsWith(join("mc-tokenizer", "src")),
        );
        expect(
            blind.issues.some(
                (i) => i.includes("mc-tokenizer/src") && i.includes("missing on disk"),
            ),
        ).toBe(true);
        const ghost = [...RUST_PROD_ROOTS, join(CRATES, "mc-nope", "src")];
        expect(rustZoneScan(ghost).issues).toEqual([]); // non-canonical extra root is inert
        const missing = [...RUST_PROD_ROOTS];
        missing[0] = join(CRATES, "mc-core", "src-renamed-away");
        // mc-core/src no longer in roots → floor names it.
        expect(rustZoneScan(missing).issues.some((i) => i.includes("mc-core/src"))).toBe(true);
    });

    it("the module never reads the region column and carries no region vocabulary", () => {
        expect(rustRefusalOffenders()).toEqual([]);
    });

    it("control: a planted region-column reader and a planted sentinel both redden the refusal census", () => {
        const rogueReader = join(CRATES, "mc-module", "src", "__parity_rogue_reader.rs");
        const rogueSentinel = join(CRATES, "mc-module", "src", "__parity_rogue_sentinel.rs");
        // F5: the plant must also land OUTSIDE the module crate — mc-core is
        // now in the walk, and an unscanned root would let this one slip.
        const rogueCore = join(CRATES, "mc-core", "src", "__parity_rogue_core.rs");
        writeFileSync(
            rogueReader,
            '// planted\nfn f(db: &Connection) {\n    db.query_row("SELECT cached_m0_bytes FROM session_meta", [], |_| Ok(())).unwrap();\n}\n',
        );
        writeFileSync(
            rogueSentinel,
            '// planted\nconst S: &str = "<!-- mc:system-region v1 -->";\n',
        );
        writeFileSync(
            rogueCore,
            '// planted\nfn g(db: &Connection) {\n    db.query_row("SELECT cached_m0_bytes FROM session_meta", [], |_| Ok(())).unwrap();\n}\n',
        );
        try {
            const found = rustRefusalOffenders();
            expect(found.some((o) => o.includes("__parity_rogue_reader.rs: cached_m0_bytes"))).toBe(
                true,
            );
            expect(
                found.some((o) => o.includes("__parity_rogue_sentinel.rs: mc:system-region")),
            ).toBe(true);
            expect(
                found.some((o) =>
                    o.includes("mc-core/src/__parity_rogue_core.rs: cached_m0_bytes"),
                ),
            ).toBe(true);
        } finally {
            rmSync(rogueReader, { force: true });
            rmSync(rogueSentinel, { force: true });
            rmSync(rogueCore, { force: true });
        }
        expect(rustRefusalOffenders()).toEqual([]);
    });

    it("the store-repair reset list covers every column the host clear clears, region included", () => {
        // Serve parity at the repair boundary: context.db and the module
        // store.db are one consistency unit, so a repair that resets head
        // state must erase the region row and its markers with the same
        // column set the host's receipted clear uses — a missing arm leaves
        // a half-erased row that the TS reader refuses while the module
        // considers the session clean.
        const repairText = readFileSync(
            join(CRATES, "mc-module", "src", "single_store_repair.rs"),
            "utf8",
        );
        const rustResets = parseRustResetList(repairText);
        const funnelText = readFileSync(
            join(
                REPO,
                "packages",
                "plugin",
                "src",
                "features",
                "magic-context",
                "storage-meta-shared.ts",
            ),
            "utf8",
        );
        const tsClears = parseTsClearList(funnelText);
        // The region column itself is cleared by the funnel's receipted
        // clearSystemRegion (storage side), not the head clears list.
        const required = new Set<string>([...tsClears, "cached_m0_bytes"]);
        const missing = [...required].filter((c) => !rustResets.has(c));
        expect(missing).toEqual([]);
        // The region row is reset with the NULL value (erase, not empty-text:
        // an empty TEXT would present as a corrupt-but-named row).
        expect(rustResets.get("cached_m0_bytes")).toBe("Null");
    });

    it("control: dropping the region arm from the reset list reddens the parity law", () => {
        // Mechanism attack (#2644): the law must fail when the reset list
        // loses the region column — simulated on the parsed input, not the
        // source (the source arm is pinned by the green row above and the
        // Rust law in single_store_repair_tests.rs).
        const repairText = readFileSync(
            join(CRATES, "mc-module", "src", "single_store_repair.rs"),
            "utf8",
        );
        expect(repairText.includes('("cached_m0_bytes", ResetValue::Null)')).toBe(true);
        const mutated = repairText.replace('("cached_m0_bytes", ResetValue::Null),', "");
        const rustResets = parseRustResetList(mutated);
        expect(rustResets.has("cached_m0_bytes")).toBe(false);
    });
});

function parseRustResetList(text: string): Map<string, string> {
    const start = text.indexOf("const SESSION_META_RESETS");
    expect(start).toBeGreaterThan(-1);
    const block = text.slice(start, text.indexOf("];", start));
    const out = new Map<string, string>();
    for (const m of block.matchAll(/\(\s*"([a-z0-9_]+)"\s*,\s*ResetValue::(\w+)\s*\)/g)) {
        out.set(m[1], m[2]);
    }
    expect(out.size).toBeGreaterThan(0);
    return out;
}

function parseTsClearList(text: string): Set<string> {
    const start = text.indexOf("const clears: Array<[string, string | number | null]> = [");
    expect(start).toBeGreaterThan(-1);
    const block = text.slice(start, text.indexOf("];", start));
    const out = new Set<string>();
    for (const m of block.matchAll(/\[\s*"([a-z0-9_]+)"\s*,/g)) out.add(m[1]);
    expect(out.size).toBeGreaterThan(0);
    return out;
}
