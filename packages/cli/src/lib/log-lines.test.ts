import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import golden from "./__fixtures__/log_format_golden.json";
import opaqueMessages from "./__fixtures__/opaque-log-messages.json";
import {
    getMagicContextLogPaths,
    inspectLogFile,
    inspectMagicContextLogs,
    parseLogLine,
    readLogLines,
} from "./log-lines";
import { extractHistorianFailureLines } from "./logs-opencode";

const roots: string[] = [];
const original = {
    MAGIC_CONTEXT_LOG_PATH: process.env.MAGIC_CONTEXT_LOG_PATH,
    MAGIC_CONTEXT_STORAGE_DIR: process.env.MAGIC_CONTEXT_STORAGE_DIR,
    MAGIC_CONTEXT_TEST_DATA_DIR: process.env.MAGIC_CONTEXT_TEST_DATA_DIR,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
};

afterEach(() => {
    for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("parseLogLine", () => {
    it("parses the authoritative fleet grammar fixture", () => {
        const fixtureCase = golden.cases.find((entry) => entry.event.module === "magic-context");
        if (!fixtureCase) throw new Error("golden fixture has no magic-context case");

        expect(parseLogLine(fixtureCase.line)).toEqual({
            ts: "2026-09-05T10:41:03.130Z",
            level: "WARN",
            session: "ses_00fc88222ffe",
            tags: ["perf"],
            message: "transform stage folded",
            kv: { ms: "412", retry: "2" },
            grammar: "fleet",
        });
    });

    it("preserves message escaping and quoted field suffixes from every golden case", () => {
        for (const fixture of golden.cases) {
            const line = fixture.line.replace(` ${fixture.event.module} `, " magic-context ");
            const parsed = parseLogLine(line);
            expect(parsed?.message, fixture.name).toBe(fixture.event.message);
            expect(parsed?.kv, fixture.name).toEqual(Object.fromEntries(fixture.event.fields));
        }
    });

    it("retains opaque bodies even when no field or message escape grammar applies", () => {
        for (const body of [
            "",
            'invalid "',
            'invalid "  ',
            String.raw`invalid \q`,
            "status=failed",
            "failure \u001b[31m",
        ]) {
            for (const envelope of [
                "[2026-09-05T10:41:03.130Z] [magic-context][ses_opaque] ",
                "2026-09-05T10:41:03.130Z ERROR magic-context ",
            ]) {
                expect(parseLogLine(envelope + body)?.message).toBe(body);
            }
        }
    });

    it("parses the legacy bracketed grammar and maps synthetic global to no session", () => {
        expect(
            parseLogLine(
                "[2026-09-05T10:41:03.130Z] [magic-context][ses_00fc88222ffe] transform stage folded cache.read=7 cache.write=2",
            ),
        ).toEqual({
            ts: "2026-09-05T10:41:03.130Z",
            level: null,
            session: "ses_00fc88222ffe",
            tags: [],
            message: "transform stage folded",
            kv: { "cache.read": "7", "cache.write": "2" },
            grammar: "legacy",
        });
        expect(
            parseLogLine("[2026-09-05T10:41:03.130Z] [magic-context][global] maintenance completed")
                ?.session,
        ).toBeNull();
        expect(
            parseLogLine("[2026-09-05T10:41:03.130Z] [magic-context][] maintenance completed")
                ?.session,
        ).toBeNull();
    });

    for (const fixture of opaqueMessages) {
        it(`retains ${fixture.name} in historian failure extraction`, async () => {
            let line = fixture.line;
            if (fixture.name.startsWith("legacy")) {
                const root = mkdtempSync(join(tmpdir(), "mc-opaque-log-"));
                roots.push(root);
                const logPath = join(root, "writer.log");
                const loggerPath = resolve(import.meta.dir, "../../../plugin/src/shared/logger.ts");
                const body = fixture.line.slice(
                    fixture.line.indexOf("] ", fixture.line.indexOf("[magic-context]")) + 2,
                );
                const child = Bun.spawn(
                    [
                        process.execPath,
                        "-e",
                        `const {sessionLog, flushLogger} = await import(${JSON.stringify(loggerPath)});
                     Date.prototype.toISOString = () => "2026-09-05T10:41:03.130Z";
                     sessionLog("ses_opaque", ${JSON.stringify(body)}); flushLogger();`,
                    ],
                    {
                        env: {
                            ...process.env,
                            NODE_ENV: "development",
                            MAGIC_CONTEXT_LOG_PATH: logPath,
                        },
                        stdout: "pipe",
                        stderr: "pipe",
                    },
                );
                const stderr = await new Response(child.stderr).text();
                expect(await child.exited, stderr).toBe(0);
                line = readFileSync(logPath, "utf8").trimEnd();
                expect(line).toBe(fixture.line);
            }
            expect(extractHistorianFailureLines(line)).toEqual([line]);
            const parsed = parseLogLine(line);
            expect(parsed?.message).toBe(fixture.message);
            expect(parsed?.kv).toEqual(
                fixture.name.endsWith("before-fields") ? { "cache.read": "5" } : {},
            );
        });
    }

    it("rejects wrong-grammar lines instead of silently splitting them", () => {
        expect(
            parseLogLine(
                "2026-09-05T10:41:03.130Z WARN magic-context session=opencode:ses_bad transform failed: boom",
            ),
        ).toBeNull();
        expect(parseLogLine("[2026-09-05T10:41:03.130Z] unrelated text")).toBeNull();
        for (const rejected of golden.parse_rejects) {
            expect(parseLogLine(rejected.line), rejected.name).toBeNull();
        }
    });
});

describe("log path discovery", () => {
    it("enumerates an override, legacy harness path, fleet lane, and module log", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-log-paths-"));
        roots.push(root);
        process.env.MAGIC_CONTEXT_TEST_DATA_DIR = root;
        process.env.XDG_DATA_HOME = root;
        process.env.MAGIC_CONTEXT_LOG_PATH = join(root, "override.log");

        expect(getMagicContextLogPaths("omp")).toEqual([
            join(root, "override.log"),
            join(tmpdir(), "omp", "magic-context", "magic-context.log"),
            join(root, "cortexkit", "magic-context", "logs", "magic-context.omp.log"),
            join(root, "cortexkit", "magic-context", "logs", "magic-context.log"),
        ]);
    });

    it("discovers a fleet log when no legacy file exists", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-log-new-only-"));
        roots.push(root);
        const fleetPath = join(root, "storage", "logs", "magic-context.pi.log");
        mkdirSync(join(root, "storage", "logs"), { recursive: true });
        writeFileSync(
            fleetPath,
            "2026-09-05T10:41:03.000Z INFO  magic-context fleet-only message\n",
        );

        const files = inspectMagicContextLogs("pi", {
            tempDir: root,
            storageDir: join(root, "storage"),
            override: null,
        });
        expect(files.find((file) => file.exists)).toMatchObject({
            path: fleetPath,
            grammar: "fleet",
            lineCount: 1,
        });
    });

    it("reports grammar and line count and merges existing files chronologically", () => {
        const root = mkdtempSync(join(tmpdir(), "mc-log-read-"));
        roots.push(root);
        const legacy = join(root, "legacy.log");
        const fleet = join(root, "fleet.log");
        writeFileSync(
            legacy,
            "[2026-09-05T10:41:04.000Z] [magic-context][global] legacy message\n",
        );
        writeFileSync(fleet, "2026-09-05T10:41:03.000Z INFO  magic-context fleet message\n");

        const legacyInfo = inspectLogFile(legacy);
        const fleetInfo = inspectLogFile(fleet);
        expect(legacyInfo).toMatchObject({ exists: true, lineCount: 1, grammar: "legacy" });
        expect(fleetInfo).toMatchObject({ exists: true, lineCount: 1, grammar: "fleet" });
        expect(readLogLines([legacyInfo, fleetInfo])).toEqual([
            "2026-09-05T10:41:03.000Z INFO  magic-context fleet message",
            "[2026-09-05T10:41:04.000Z] [magic-context][global] legacy message",
        ]);
    });
});

describe("vendored fleet log fixture", () => {
    it("matches the authority fixture when the sibling checkout exists", () => {
        const vendored = resolve(import.meta.dir, "__fixtures__/log_format_golden.json");
        const authority = resolve(
            import.meta.dir,
            "../../../../../subconscious/crates/subc-core/tests/fixtures/log_format_golden.json",
        );
        if (!existsSync(authority)) return;
        expect(readFileSync(vendored, "utf8")).toBe(readFileSync(authority, "utf8"));
    });
});
