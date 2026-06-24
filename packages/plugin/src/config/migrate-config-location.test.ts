import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    type LegacyConfigSource,
    migrateConfigFile,
    resolveLegacyConfigSources,
} from "./migrate-config-location";

function tmp(): string {
    return mkdtempSync(join(tmpdir(), "mc-cfgloc-"));
}

function src(path: string, label = "legacy"): LegacyConfigSource {
    return { path, label };
}

describe("migrateConfigFile (location migration)", () => {
    it("no-ops when no legacy source exists", () => {
        const dir = tmp();
        try {
            const target = join(dir, ".cortexkit", "magic-context.jsonc");
            const r = migrateConfigFile({
                scope: "project",
                targetPath: target,
                legacySources: [src(join(dir, "magic-context.jsonc"))],
            });
            expect(r.migrated).toBe(false);
            expect(r.conflict).toBe(false);
            expect(existsSync(target)).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("reclaims a stale (crashed-holder) lock within a bounded budget instead of freezing or throwing", () => {
        const dir = tmp();
        try {
            const target = join(dir, ".cortexkit", "magic-context.jsonc");
            const legacy = join(dir, "magic-context.jsonc");
            writeFileSync(legacy, '{"enabled":false}');
            // A leftover lock dir from a crashed holder. The old design (60s
            // stale / 30s timeout) made reclaim unreachable — a waiter froze
            // init for 30s then THREW. The fix keeps stale < timeout so the
            // waiter reclaims and proceeds, bounded and never throwing.
            mkdirSync(`${target}.lock`, { recursive: true });
            const start = Date.now();
            const r = migrateConfigFile({
                scope: "project",
                targetPath: target,
                legacySources: [src(legacy)],
            });
            const elapsed = Date.now() - start;
            expect(elapsed).toBeLessThan(8_000);
            expect(r.migrated).toBe(true);
            expect(existsSync(target)).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("moves a single legacy source to the target and leaves a .MOVED_READPLEASE marker", () => {
        const dir = tmp();
        try {
            const legacy = join(dir, ".opencode", "magic-context.jsonc");
            mkdirSync(join(dir, ".opencode"), { recursive: true });
            writeFileSync(legacy, '{ "ctx_reduce_enabled": true }');
            const target = join(dir, ".cortexkit", "magic-context.jsonc");

            const r = migrateConfigFile({
                scope: "project",
                targetPath: target,
                legacySources: [src(legacy)],
            });

            expect(r.migrated).toBe(true);
            expect(r.conflict).toBe(false);
            // Content is at the target...
            expect(readFileSync(target, "utf8")).toContain("ctx_reduce_enabled");
            // ...the legacy file is gone (idempotency comes from this)...
            expect(existsSync(legacy)).toBe(false);
            // ...and a human breadcrumb preserves the original below a header.
            const marker = `${legacy}.MOVED_READPLEASE`;
            expect(existsSync(marker)).toBe(true);
            const markerText = readFileSync(marker, "utf8");
            expect(markerText).toContain("configuration moved");
            expect(markerText).toContain(target);
            expect(markerText).toContain("ctx_reduce_enabled");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("is idempotent: a second run finds no legacy source and no-ops", () => {
        const dir = tmp();
        try {
            const legacy = join(dir, "magic-context.jsonc");
            writeFileSync(legacy, '{ "protected_tags": 5 }');
            const target = join(dir, ".cortexkit", "magic-context.jsonc");
            const opts = {
                scope: "project" as const,
                targetPath: target,
                legacySources: [src(legacy)],
            };
            const first = migrateConfigFile(opts);
            expect(first.migrated).toBe(true);
            const second = migrateConfigFile(opts);
            expect(second.migrated).toBe(false);
            expect(second.conflict).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("moves legacy aside (no overwrite) when target already exists and matches semantically", () => {
        const dir = tmp();
        try {
            const target = join(dir, ".cortexkit", "magic-context.jsonc");
            mkdirSync(join(dir, ".cortexkit"), { recursive: true });
            // Target = pretty-printed; legacy = compact + comment + reordered keys.
            writeFileSync(target, '{\n  "protected_tags": 5,\n  "cache_ttl": "1h"\n}\n');
            const legacy = join(dir, ".opencode", "magic-context.jsonc");
            mkdirSync(join(dir, ".opencode"), { recursive: true });
            writeFileSync(legacy, '// mine\n{ "cache_ttl": "1h", "protected_tags": 5, }');

            const r = migrateConfigFile({
                scope: "project",
                targetPath: target,
                legacySources: [src(legacy)],
            });

            expect(r.migrated).toBe(false);
            expect(r.conflict).toBe(false);
            // Target untouched (not overwritten), legacy moved aside.
            expect(readFileSync(target, "utf8")).toContain('"protected_tags": 5');
            expect(existsSync(legacy)).toBe(false);
            expect(existsSync(`${legacy}.MOVED_READPLEASE`)).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("REFUSES (conflict) when target exists with different settings — leaves both untouched", () => {
        const dir = tmp();
        try {
            const target = join(dir, ".cortexkit", "magic-context.jsonc");
            mkdirSync(join(dir, ".cortexkit"), { recursive: true });
            writeFileSync(target, '{ "protected_tags": 5 }');
            const legacy = join(dir, ".opencode", "magic-context.jsonc");
            mkdirSync(join(dir, ".opencode"), { recursive: true });
            writeFileSync(legacy, '{ "protected_tags": 9 }');

            const r = migrateConfigFile({
                scope: "project",
                targetPath: target,
                legacySources: [src(legacy)],
            });

            expect(r.conflict).toBe(true);
            expect(r.migrated).toBe(false);
            expect(r.warnings.join("\n")).toContain("already exists with different settings");
            // BOTH left as-is for manual reconciliation — never auto-clobbered.
            expect(readFileSync(target, "utf8")).toContain('"protected_tags": 5');
            expect(readFileSync(legacy, "utf8")).toContain('"protected_tags": 9');
            expect(existsSync(`${legacy}.MOVED_READPLEASE`)).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("REFUSES (conflict) when multiple legacy sources disagree and no target exists", () => {
        const dir = tmp();
        try {
            const a = join(dir, ".opencode", "magic-context.jsonc");
            const b = join(dir, ".pi", "magic-context.jsonc");
            mkdirSync(join(dir, ".opencode"), { recursive: true });
            mkdirSync(join(dir, ".pi"), { recursive: true });
            writeFileSync(a, '{ "protected_tags": 5 }');
            writeFileSync(b, '{ "protected_tags": 9 }');
            const target = join(dir, ".cortexkit", "magic-context.jsonc");

            const r = migrateConfigFile({
                scope: "project",
                targetPath: target,
                legacySources: [src(a), src(b)],
            });

            expect(r.conflict).toBe(true);
            expect(r.migrated).toBe(false);
            expect(existsSync(target)).toBe(false);
            // Neither moved aside — user reconciles by hand.
            expect(existsSync(a)).toBe(true);
            expect(existsSync(b)).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("migrates once and moves ALL matching legacy sources aside when they agree", () => {
        const dir = tmp();
        try {
            const a = join(dir, ".opencode", "magic-context.jsonc");
            const b = join(dir, ".pi", "magic-context.jsonc");
            mkdirSync(join(dir, ".opencode"), { recursive: true });
            mkdirSync(join(dir, ".pi"), { recursive: true });
            writeFileSync(a, '{ "protected_tags": 5 }');
            writeFileSync(b, '{ "protected_tags": 5 }'); // same
            const target = join(dir, ".cortexkit", "magic-context.jsonc");

            const r = migrateConfigFile({
                scope: "project",
                targetPath: target,
                legacySources: [src(a), src(b)],
            });

            expect(r.migrated).toBe(true);
            expect(existsSync(target)).toBe(true);
            expect(existsSync(`${a}.MOVED_READPLEASE`)).toBe(true);
            expect(existsSync(`${b}.MOVED_READPLEASE`)).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("resolveLegacyConfigSources", () => {
    it("includes the bare-root project source unique to Magic Context", () => {
        const sources = resolveLegacyConfigSources("/proj");
        const projectPaths = sources.project.map((s) => s.path);
        // bare root + .opencode + .pi, each in {.jsonc,.json}
        expect(projectPaths).toContain("/proj/magic-context.jsonc");
        expect(projectPaths).toContain("/proj/magic-context.json");
        expect(projectPaths).toContain("/proj/.opencode/magic-context.jsonc");
        expect(projectPaths).toContain("/proj/.pi/magic-context.jsonc");
    });

    it("includes both OpenCode and Pi user sources", () => {
        const sources = resolveLegacyConfigSources("/proj");
        const userPaths = sources.user.map((s) => s.path);
        expect(userPaths.some((p) => p.includes(join("opencode", "magic-context.jsonc")))).toBe(
            true,
        );
        expect(userPaths.some((p) => p.includes(join(".pi", "agent", "magic-context.jsonc")))).toBe(
            true,
        );
    });
});
