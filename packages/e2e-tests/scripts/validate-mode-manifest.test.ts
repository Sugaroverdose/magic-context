import { describe, expect, it } from "bun:test";
import {
    filesForMode,
    validateManifestDocument,
    validateModeManifest,
    type ModeManifest,
} from "./validate-mode-manifest";

const validation = validateModeManifest();

function manifestWith(entries: ModeManifest["entries"]): ModeManifest {
    return {
        schema: 1,
        header: "test manifest",
        entries,
    };
}

describe("mode manifest validator", () => {
    it("covers every live e2e test exactly once", () => {
        expect(validation.files.length).toBe(74);
        expect(validation.manifest.entries).toHaveLength(validation.files.length);
        expect(new Set(validation.manifest.entries.map((entry) => entry.path)).size).toBe(
            validation.files.length,
        );
        expect(validation.manifest.entries.map((entry) => entry.path).sort()).toEqual(validation.files);
    });

    it("derives separate TS and Rust invocation lists", () => {
        const ts = filesForMode(validation, "ts");
        const rust = filesForMode(validation, "rust");
        expect(ts).toHaveLength(26);
        expect(rust).toHaveLength(45);
        expect(ts.filter((path) => path.startsWith("tests/pi-")).length).toBe(1);
        expect(filesForMode(validation, "ts", "opencode")).toHaveLength(25);
        expect(filesForMode(validation, "ts", "pi")).toHaveLength(21);
        expect(filesForMode(validation, "ts", "opencode2")).toHaveLength(20);
        // OMP hashes each request into its system header, breaking within-session byte identity
        // in cache-stability and long-running-session; their manifest entries declare the omission.
        expect(filesForMode(validation, "ts", "omp")).toHaveLength(18);
        const excluded = validation.manifest.entries
            .filter((entry) => entry.tier === "excluded")
            .map((entry) => entry.path);
        expect([...excluded].sort()).toEqual([
            "tests/opencode2/adapters-s2-contracts.test.ts",
            "tests/opencode2/adapters-s3-marker-policy.test.ts",
            "tests/opencode2/automatic-s3-paths.test.ts",
            "tests/opencode2/context-s2-lanes.test.ts",
            "tests/opencode2/entry-s2-context.test.ts",
            "tests/opencode2/fold-s3-owner.test.ts",
            "tests/opencode2/harness-s3-identity.test.ts",
            "tests/opencode2/hidden-child-ga.test.ts",
            "tests/opencode2/marker-s3-runtime.test.ts",
            "tests/opencode2/pins.test.ts",
            "tests/opencode2/probes.test.ts",
            "tests/opencode2/prompt-surface-s6.test.ts",
            "tests/opencode2/runner.test.ts",
            "tests/opencode2/store-generation-conversion.test.ts",
            "tests/opencode2/store-reader.test.ts",
            "tests/window-overlay-reload.test.ts",
        ]);
        expect(new Set([...ts, ...rust]).size).toBe(validation.files.length - excluded.length);
    });

    it("rejects a missing, duplicated, or dead manifest path", () => {
        const entries = validation.manifest.entries;
        expect(() => validateManifestDocument(manifestWith(entries.slice(0, -1)), validation.files)).toThrow(
            /missing manifest entries/,
        );
        expect(() =>
            validateManifestDocument(manifestWith([...entries, entries[0]!]), validation.files),
        ).toThrow(/duplicate manifest entry/);
        expect(() =>
            validateManifestDocument(
                manifestWith([
                    ...entries.slice(0, -1),
                    {
                        ...entries.at(-1)!,
                        path: "tests/not-live.test.ts",
                    },
                ]),
                validation.files,
            ),
        ).toThrow(/dead or out-of-scope/);
    });

    it("requires explicit hosts and exposes shared behavior scenarios to each declared lane", () => {
        const smoke = validation.manifest.entries.find((entry) => entry.path === "tests/smoke.test.ts");
        const ordinary = validation.manifest.entries.find((entry) => entry.path === "tests/cache-invariants.test.ts");
        const opencode2 = validation.manifest.entries.find((entry) => entry.path === "tests/opencode2/runner.test.ts");
        expect(validation.manifest.entries.every((entry) => entry.hosts.length > 0)).toBe(true);
        expect(smoke?.hosts).toEqual(["opencode", "opencode2", "pi", "omp"]);
        expect(ordinary?.hosts).toEqual(["opencode", "opencode2", "pi", "omp"]);
        expect(opencode2?.hosts).toEqual(["opencode2"]);
    });

    it("accepts a both-modes entry in both invocation lists", () => {
        const entries = validation.manifest.entries;
        const both = validateManifestDocument(
            manifestWith([
                {
                    ...entries[0]!,
                    tier: "both-modes",
                    invocation: { ts: true, rust: true },
                    contract_refs: ["PARITY.md"],
                },
                ...entries.slice(1),
            ]),
            validation.files,
        );
        expect(filesForMode(both, "ts")).toContain(entries[0]!.path);
        expect(filesForMode(both, "rust")).toContain(entries[0]!.path);
    });

    it("rejects invalid tiers, hosts, silent behavior omissions, and a both-modes entry missing an invocation", () => {
        const entries = validation.manifest.entries;
        expect(() =>
            validateManifestDocument(
                manifestWith([
                    {
                        ...entries[0]!,
                        tier: "not-a-tier" as never,
                    },
                    ...entries.slice(1),
                ]),
                validation.files,
            ),
        ).toThrow(/invalid classification/);
        expect(() =>
            validateManifestDocument(
                manifestWith([
                    {
                        ...entries[0]!,
                        hosts: ["opencode", "opencode"] as never,
                    },
                    ...entries.slice(1),
                ]),
                validation.files,
            ),
        ).toThrow(/invalid hosts/);
        const behaviorIndex = entries.findIndex((entry) => entry.behavior === true && entry.hosts.length === 4);
        const behavior = entries[behaviorIndex]!;
        expect(() =>
            validateManifestDocument(
                manifestWith([
                    ...entries.slice(0, behaviorIndex),
                    { ...behavior, hosts: ["opencode"], divergences: [] },
                    ...entries.slice(behaviorIndex + 1),
                ]),
                validation.files,
            ),
        ).toThrow(/silently omits behavior hosts/);
        expect(() =>
            validateManifestDocument(
                manifestWith([
                    {
                        ...entries[0]!,
                        tier: "both-modes",
                        invocation: { ts: true, rust: false },
                    },
                    ...entries.slice(1),
                ]),
                validation.files,
            ),
        ).toThrow(/invocation disagrees with both-modes/);
    });
});
