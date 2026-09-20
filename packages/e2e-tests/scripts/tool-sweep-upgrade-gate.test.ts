import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const oldPlugin = process.env.MC_PROBE_UPGRADE_FROM;
const adopted = process.env.MC_PROBE_EXPECT_ADOPTED === "1";
// MC_PROBE_UPGRADE_FROM names the initial plugin entrypoint; restart reuses the same databases.
test.skipIf(!oldPlugin)(adopted ? "scoped gate restart preserves adopted priced marker-seam prefix" : "scoped gate upgrade preserves pre-fix priced marker-seam prefix", () => {
    const output = mkdtempSync(join(tmpdir(), "scoped-upgrade-gate-"));
    execFileSync(process.execPath, [join(import.meta.dir, "ckios-reasoning-only-probe.ts"), output], {
        env: { ...process.env, MC_PROBE_LANE: "marker-drops", MC_SPECIMEN_DIR: "" },
        timeout: 180_000, stdio: "pipe",
    });
    const bodies = JSON.parse(readFileSync(join(output, "marker-drops-bodies.json"), "utf8"));
    expect(bodies).toHaveLength(2);
    const [a, b] = bodies.map((body: { messages: unknown[] }) => body.messages);
    const normalized = (value: unknown) => JSON.stringify(value, (key, item) => key === "cache_control" ? undefined : item);
    const sha = (value: unknown) => createHash("sha256").update(normalized(value)).digest("hex");
    const firstDivergence = Array.from({ length: a.length }, (_, i) => i).find(i => normalized(a[i]) !== normalized(b[i])) ?? -1;
    const target = (messages: unknown[]) => messages.findIndex(message => JSON.stringify(message).includes("CKIOS_REASONING_ONLY"));
    const hooks = readFileSync(join(output, "marker-drops-after.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const [hookA, hookB] = hooks.slice(-2);
    const rawSha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const hookFirstDivergence = Array.from({ length: hookA.length }, (_, i) => i).find(i => JSON.stringify(hookA[i]) !== JSON.stringify(hookB[i])) ?? -1;
    const evidence = { output, aSha256: sha(a), bPrefixSha256: sha(b.slice(0, a.length)), firstDivergence, targetA: target(a), targetB: target(b), hookASha256: rawSha(hookA), hookBPrefixSha256: rawSha(hookB.slice(0, hookA.length)), hookFirstDivergence };
    console.log(`SCOPED_GATE upgrade ${JSON.stringify(evidence)}`);
    writeFileSync(join(output, "gate-evidence.json"), JSON.stringify(evidence, null, 2));
    const log = readFileSync(join(output, "marker-drops.log"), "utf8");
    const preLog = readFileSync(join(output, "marker-drops-pre-upgrade.log"), "utf8");
    expect(preLog).toContain("compaction-marker drain: applied at ordinal 4");
    expect(preLog).toContain("decision=execute");
    expect(log).toContain("decision=defer");
    expect(readFileSync(join(output, "marker-drops-pre-upgrade-ledger.json"), "utf8").includes("@tool-sweep-scoped")).toBe(adopted);
    expect(target(a)).toBeGreaterThan(0);
    expect(sha(b.slice(0, a.length))).toBe(sha(a));
    expect(rawSha(hookB.slice(0, hookA.length))).toBe(rawSha(hookA));
}, 240_000);
