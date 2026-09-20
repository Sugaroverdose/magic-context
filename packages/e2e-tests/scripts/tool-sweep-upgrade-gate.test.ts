import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const oldPlugin = process.env.MC_PROBE_UPGRADE_FROM;
const adopted = process.env.MC_PROBE_EXPECT_ADOPTED === "1";
const lane = process.env.MC_GATE_BOUNDARY === "1" ? "marker-dropped-boundary" : "marker-drops";
// MC_PROBE_UPGRADE_FROM names the initial plugin entrypoint; restart reuses the same databases.
test.skipIf(!oldPlugin)(lane === "marker-dropped-boundary" ? "marker boundary upgrade preserves pre-fix priced drain prefix" : adopted ? "scoped gate restart preserves adopted priced marker-seam prefix" : "scoped gate upgrade preserves pre-fix priced marker-seam prefix", () => {
    const output = mkdtempSync(join(tmpdir(), "scoped-upgrade-gate-"));
    execFileSync(process.execPath, [join(import.meta.dir, "ckios-reasoning-only-probe.ts"), output], {
        env: { ...process.env, MC_PROBE_LANE: lane, MC_SPECIMEN_DIR: "" },
        timeout: 180_000, stdio: "pipe",
    });
    const bodies = JSON.parse(readFileSync(join(output, `${lane}-bodies.json`), "utf8"));
    expect(bodies).toHaveLength(2);
    const [a, b] = bodies.map((body: { messages: unknown[] }) => body.messages);
    const normalized = (value: unknown) => JSON.stringify(value, (key, item) => key === "cache_control" ? undefined : item);
    const sha = (value: unknown) => createHash("sha256").update(normalized(value)).digest("hex");
    const firstDivergence = Array.from({ length: a.length }, (_, i) => i).find(i => normalized(a[i]) !== normalized(b[i])) ?? -1;
    const target = (messages: unknown[]) => messages.findIndex(message => JSON.stringify(message).includes("CKIOS_REASONING_ONLY"));
    const hooks = readFileSync(join(output, `${lane}-after.jsonl`), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const [hookA, hookB] = hooks.slice(-2);
    const rawSha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const hookFirstDivergence = Array.from({ length: hookA.length }, (_, i) => i).find(i => JSON.stringify(hookA[i]) !== JSON.stringify(hookB[i])) ?? -1;
    const evidence = { output, aSha256: sha(a), bPrefixSha256: sha(b.slice(0, a.length)), firstDivergence, targetA: target(a), targetB: target(b), hookASha256: rawSha(hookA), hookBPrefixSha256: rawSha(hookB.slice(0, hookA.length)), hookFirstDivergence };
    console.log(`SCOPED_GATE upgrade ${JSON.stringify(evidence)}`);
    writeFileSync(join(output, "gate-evidence.json"), JSON.stringify(evidence, null, 2));
    const log = readFileSync(join(output, `${lane}.log`), "utf8");
    const preLog = readFileSync(join(output, `${lane}-pre-upgrade.log`), "utf8");
    expect(preLog).toContain(`compaction-marker drain: applied at ordinal ${lane === "marker-dropped-boundary" ? 6 : 4}`);
    expect(preLog).toContain("decision=execute");
    const afterRestart = log.slice(preLog.length);
    expect(afterRestart).toContain("decision=defer");
    expect(afterRestart).not.toContain("decision=execute");
    expect(readFileSync(join(output, `${lane}-pre-upgrade-ledger.json`), "utf8").includes("@tool-sweep-scoped")).toBe(adopted);
    if (lane === "marker-dropped-boundary") {
        const fixture = JSON.parse(readFileSync(join(output, `${lane}-boundary-fixture.json`), "utf8"));
        expect(fixture.boundary.info.role).toBe("assistant");
        expect(fixture.boundary.parts.some((part: { type: string }) => part.type === "tool")).toBe(true);
        expect(fixture.tags).toHaveLength(1);
        expect(fixture.tags[0]).toMatchObject({ status: "dropped", drop_mode: "full", tool_owner_message_id: fixture.boundary.info.id });
    }
    expect(target(a)).toBeGreaterThan(0);
    expect(sha(b.slice(0, a.length))).toBe(sha(a));
    expect(rawSha(hookB.slice(0, hookA.length))).toBe(rawSha(hookA));
}, 240_000);
