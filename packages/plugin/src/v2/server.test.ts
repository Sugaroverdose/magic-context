import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
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
// OpenCode 1.18.30 (the shipping v1 host) resolves a plugin's entry from
// `exports["./server"]` BEFORE `main` (packages/opencode/src/plugin/shared.ts,
// resolvePackageEntrypoint) and then requires the default export to carry a
// `server()` function. Exposing the v2 `{id, setup}` module at `./server`
// therefore breaks every v1 install: the host loads the v2 object, throws
// "must default export an object with server()", and the plugin never boots
// (caught by the Docker smoke on the v0.42.3 release, not by any unit test).
// Until the v2 entry serves both loaders from one module, the package must not
// publish `./server` or a root `server.js` at all.
test("published package exposes no ./server entry the v1 host would load as v2", () => {
    const directory = resolve(import.meta.dir, "../..");
    const pkg = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8")) as {
        exports: Record<string, unknown>;
        files: string[];
    };
    expect(Object.keys(pkg.exports)).not.toContain("./server");
    expect(pkg.files).not.toContain("server.js");
    expect(existsSync(resolve(directory, "server.js"))).toBe(false);
    // The v1 loader's contract for whatever `./server` would resolve to: a
    // default export with a server() function. Encode it so re-adding the
    // export with a v2-only default reddens here instead of in production.
    const v1Accepts = (candidate: unknown) =>
        typeof candidate === "object" &&
        candidate !== null &&
        "server" in candidate &&
        typeof (candidate as { server: unknown }).server === "function";
    expect(v1Accepts(server)).toBe(false);
    const byDirectory = Host.resolve({ directory });
    expect(byDirectory.rpc).toBeUndefined();
});

// The v2 SDK's OpenTUI peers conflict with the v1 TUI runtime. Keep v2
// development tooling out of the dependency tree npm installs for v1 users.
test("published runtime dependencies contain no v2 @opencode packages", () => {
    const pkg = JSON.parse(
        readFileSync(resolve(import.meta.dir, "../../package.json"), "utf8"),
    ) as {
        dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).filter((name) => name.startsWith("@opencode/"))).toEqual(
        [],
    );
});
