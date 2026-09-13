import { expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { Host } from "@opencode/plugin/host";
import { Schema } from "effect";
import server from "./server";

// Verbatim GA Module schema, core-module-schema.excerpt.js:34-45.
const Module = Schema.Struct({
    default: Schema.Union([
        Schema.Struct({
            id: Schema.String,
            effect: Schema.declare((input) => typeof input === "function"),
        }),
        Schema.Struct({
            id: Schema.String,
            setup: Schema.declare((input) => typeof input === "function"),
        }),
    ]),
});
const decode = Schema.decodeUnknownSync(Module);
test("GA Module accepts exact id/setup export", () => {
    expect(decode({ default: server }).default).toEqual(server);
    expect(Object.keys(server).sort()).toEqual(["id", "setup"]);
});
test("GA Module ignores extras and rejects v1 id/server with LoadError cause", () => {
    expect(decode({ default: { ...server, stray: true } }).default).toEqual(server);
    expect(() => decode({ default: { id: server.id, server() {} } })).toThrow();
});
test("rpc_entry_absence_probe and named/directory targets share server identity", async () => {
    const directory = resolve(import.meta.dir, "../..");
    const byDirectory = Host.resolve({ directory });
    const byName = Host.resolve({ directory, name: "@cortexkit/opencode-magic-context" });
    expect(byDirectory.rpc).toBeUndefined();
    expect(byName.rpc).toBeUndefined();
    expect(byDirectory.server).toBeDefined();
    expect(byName.server).toBeDefined();
    const a = (await Host.load(byDirectory.server!)) as { default: typeof server };
    const b = (await Host.load(byName.server!)) as { default: typeof server };
    expect(a.default).toBe(b.default);
    expect(Object.keys(a.default as object).sort()).toEqual(["id", "setup"]);
    expect(realpathSync(resolve(directory, "server.js"))).toBe(resolve(directory, "server.js"));
    const lines = readFileSync(resolve(directory, "server.js"), "utf8")
        .split("\n")
        .filter((line) => line.trim() && !line.startsWith("//"));
    expect(lines).toEqual(['export { default } from "./dist/v2/server.js";']);
});
