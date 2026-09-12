import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The plugin entry hands OpenCode a hand-written wrapper object, not the
 * runtime hook object itself, and OpenCode dispatches only the keys the
 * wrapper exposes. A hook key added to the runtime object but not to the
 * wrapper is silently never called: the #431 dropped-input guard shipped that
 * way in v0.42.0 and was unreachable on every OpenCode surface. This fence
 * reads both sources and refuses any runtime hook key the wrapper does not
 * delegate.
 */
describe("plugin entry delegates every runtime hook key", () => {
    test("wrapper exposes each key the runtime hook object registers", () => {
        const runtime = readFileSync(
            join(import.meta.dir, "hooks", "magic-context", "hook.ts"),
            "utf8",
        );
        const entry = readFileSync(join(import.meta.dir, "index.ts"), "utf8");

        // The literal ends at the first line that closes it at four-space
        // indent; the non-enumerable debug properties defined afterwards are
        // not OpenCode hooks.
        const start = runtime.indexOf("const hooks = {");
        const end = runtime.indexOf("\n    };", start);
        const hooksObject = runtime.slice(start, end);
        const runtimeKeys = new Set(
            [...hooksObject.matchAll(/^\s{8}(?:"([a-z.]+)"|([a-zA-Z]+)):/gm)].map(
                (m) => m[1] ?? m[2],
            ),
        );
        expect(runtimeKeys.size).toBeGreaterThanOrEqual(6);

        // Keys OpenCode dispatches to the wrapper. `event` is delegated through a
        // dedicated handler rather than the generic pass-through, so it is
        // asserted separately below.
        const delegated = new Set(
            [...entry.matchAll(/magicContextRuntime\.magicContext\?\.\["([a-z.]+)"\]/g)].map(
                (m) => m[1],
            ),
        );
        for (const key of runtimeKeys) {
            if (key === "event" || key === "experimental.chat.messages.transform") continue;
            expect(delegated.has(key), `entry wrapper does not delegate "${key}"`).toBe(true);
        }
        expect(entry).toMatch(/^\s{8}event: createEventHandler\(/m);
        expect(entry).toMatch(/^\s{8}"experimental\.chat\.messages\.transform":/m);
    });
});
