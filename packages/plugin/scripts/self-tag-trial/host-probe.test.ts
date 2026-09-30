import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("C and D guidance reaches the pinned host and is absent for A", () => {
    const base = join(tmpdir(), "magic-context", "self-tag-trial");
    mkdirSync(base, { recursive: true });
    const output = join(mkdtempSync(join(base, "proof-")), "proof.json");
    execFileSync(process.execPath, [join(import.meta.dir, "host-probe.ts"), output], { stdio: "pipe" });
    const proof = JSON.parse(readFileSync(output, "utf8"));
    expect(proof.records.map((r: any) => r.variant)).toEqual(["A", "B", "C", "D"]);
    expect(proof.realModelCalls).toBe(0);
}, 120000);
