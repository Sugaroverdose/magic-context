/// <reference types="bun-types" />
import { describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, constants } from "node:fs";
import { join } from "node:path";
import { RustTestHarness } from "../src/rust-harness";
import { rustPrereqs } from "../src/rust-scenario-support";
import { SubcModuleTransport } from "../../plugin/src/hooks/magic-context/module-transport";
import { createRustModeTransform } from "../../plugin/src/hooks/magic-context/rust-mode-transform";
import { setRawMessageProvider } from "../../plugin/src/hooks/magic-context/read-session-chunk";
import { closeReadOnlySessionDb } from "../../plugin/src/hooks/magic-context/read-session-db";
import type { TransformDeps } from "../../plugin/src/hooks/magic-context/transform";
import type { MessageLike } from "../../plugin/src/hooks/magic-context/transform-operations";
import { Database } from "../../plugin/src/shared/sqlite";
import * as logger from "../../plugin/src/shared/logger";
import type { ContextDatabase } from "../../plugin/src/features/magic-context/storage";
import { initializeDatabase } from "../../plugin/src/features/magic-context/storage-db";
import { runMigrations } from "../../plugin/src/features/magic-context/migrations";
import { getOrCreateSessionMeta } from "../../plugin/src/features/magic-context/storage-meta";

// The daemon and module are real; only the host's raw-session reader is seeded in memory.
// No production store, daemon connection file, or installed binary is used.
describe.skipIf(!rustPrereqs.ok)("rust adapter performance", () => {
    it("profiles four defer passes over a 1500-message tool-heavy session", async () => {
        const h = await RustTestHarness.create({ startHistorianProducer: false });
        const originalDataHome = process.env.XDG_DATA_HOME;
        process.env.XDG_DATA_HOME = h.env.dataDir;
        const snapshot = process.env.MC_ADAPTER_CONTEXT_SNAPSHOT;
        const dbPath = join(h.env.dataDir, "adapter-context.db");
        if (snapshot) copyFileSync(snapshot, dbPath, constants.COPYFILE_FICLONE);
        const db = new Database(snapshot ? dbPath : ":memory:") as ContextDatabase;
        if (!snapshot) { initializeDatabase(db); runMigrations(db); }
        const sessionId = "ses_adapter_perf";
        getOrCreateSessionMeta(db, sessionId);
        if (snapshot) {
            const sourceSession = process.env.MC_ADAPTER_SNAPSHOT_SESSION ?? "ses_227ce5788ffeRPA9THoPLOQreO";
            const columns = ["note_nudge_anchors", "auto_search_hint_decisions", "trailing_blank_decisions", "merged_reasoning_stripped_ids"];
            const source = db.prepare(`SELECT ${columns.join(",")} FROM session_meta WHERE session_id = ?`).get(sourceSession) as Record<string, string>;
            expect(source).toBeTruthy();
            for (const column of columns) db.prepare(`UPDATE session_meta SET ${column} = ? WHERE session_id = ?`).run(source[column], sessionId);
            console.log(`adapter-snapshot bytes=${JSON.stringify(Object.fromEntries(columns.map(c => [c, source[c]?.length])))}`);
        }
        const messages: MessageLike[] = Array.from({ length: 1500 }, (_, i) => ({
            info: { id: `msg_perf_${String(i).padStart(5, "0")}`, role: i % 5 === 0 ? "user" : "assistant", sessionID: sessionId, model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" } },
            parts: i % 5 === 0
                ? [{ type: "text", text: `request ${i} ${"y".repeat(1000)}` }]
                : [{ type: "tool", callID: `call_${i}`, tool: "read", state: { status: "completed", input: { path: `src/${i}.ts` }, output: `result ${i} ${"x".repeat(1000)}` } }],
        }));
        const rows = messages.map((m, i) => ({ id: m.info.id as string, ordinal: i + 1, role: String(m.info.role), parts: m.parts, createdAt: i + 1, timeCreated: i + 1, contributesOrdinal: true, hasValidInfo: true }));
        const unregister = setRawMessageProvider(sessionId, {
            readMessages: () => rows,
            readMessageOrdinalPage: (after, limit) => rows.filter(r => !after || r.timeCreated > after.timeCreated).slice(0, limit),
            getStoredMessageCount: () => rows.length,
            readMessagePartsById: id => {
                const index = rows.findIndex(r => r.id === id);
                const message = messages[index];
                return message ? { id, role: String(message.info.role), parts: message.parts, createdAt: index + 1 } : null;
            },
        });
        const transport = new SubcModuleTransport(h.subc.connectionFile);
        let latestResponse: Record<string, unknown> = {};
        let requestObservedAtMs: unknown;
        const call = transport.call.bind(transport);
        transport.call = async args => {
            const response = await call(args);
            if (args.method === "transform") {
                latestResponse = response as Record<string, unknown>;
                requestObservedAtMs = (args.body as Record<string, unknown>).request_observed_at_ms;
            }
            return response;
        };
        const logs: string[] = [];
        const log = spyOn(logger, "sessionLog").mockImplementation((_session, ...args) => { logs.push(args.join(" ")); });
        const deps: TransformDeps = {
            tagger: {} as TransformDeps["tagger"], scheduler: {} as TransformDeps["scheduler"],
            contextUsageMap: new Map(), db, protectedTokens: 4, clearReasoningAge: 50,
            historyRefreshSessions: new Set(), pendingMaterializationSessions: new Set(), lastHeuristicsTurnId: new Map(),
            directory: h.env.workdir, projectPath: h.env.workdir,
            memoryConfig: { enabled: false, injectionBudgetTokens: 1000, autoPromote: false },
            liveModelBySession: new Map([[sessionId, { providerID: "anthropic", modelID: "claude-sonnet-4-5" }]]), sessionDirectoryBySession: new Map(), transformMode: "rust", rustModeModuleClient: transport,
        };
        const transform = createRustModeTransform(deps, { moduleClient: transport, projectRoot: h.env.workdir });
        try {
            for (let pass = 0; pass < 5; pass++) {
                if (pass > 0) {
                    const i = messages.length;
                    const message: MessageLike = { info: { id: `msg_perf_${String(i).padStart(5, "0")}`, role: "user", sessionID: sessionId, model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" } }, parts: [{ type: "text", text: `defer ${pass} ${"z".repeat(7200)}` }] };
                    messages.push(message);
                    rows.push({ id: message.info.id as string, ordinal: i + 1, role: "user", parts: message.parts, createdAt: i + 1, timeCreated: i + 1, contributesOrdinal: true, hasValidInfo: true });
                }
                const output: { messages: unknown[] } = { messages: [] };
                const start = performance.now();
                await transform.run(sessionId, messages, output, getOrCreateSessionMeta(db, sessionId));
                const elapsed = performance.now() - start;
                const line = logs.findLast(l => l.startsWith("rust pass:"));
                console.log(`adapter-perf pass=${pass} wall_ms=${elapsed.toFixed(2)} sha256=${createHash("sha256").update(JSON.stringify(output.messages)).digest("hex")} ${line}`);
                console.log(`adapter-response observed=${requestObservedAtMs} timings=${JSON.stringify(latestResponse.timings)} delta=${JSON.stringify((latestResponse.native_messages_delta as { replace_from?: number })?.replace_from)}`);
                console.log(h.subc.moduleLog().split("\n").filter(l => l.includes("mc-pass-timing") && l.includes(String(requestObservedAtMs))).join("\n"));
                if (!line?.includes("applied=true")) console.log(logs.join("\n"));
                expect(line).toContain("applied=true");
                if (pass > 0) expect(line).toContain("decision=SOFT+");
                await Bun.sleep(20);
            }
        } finally {
            log.mockRestore();
            await transform.clearSession(sessionId);
            unregister();
            closeReadOnlySessionDb();
            db.close();
            if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
            else process.env.XDG_DATA_HOME = originalDataHome;
            await h.dispose();
        }
    }, 600_000);
});
