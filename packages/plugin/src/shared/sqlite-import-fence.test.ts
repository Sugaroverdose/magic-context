import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `sqlite.ts` is executed directly by Node in CI's `node:sqlite` smoke and by
// Pi/Desktop hosts. Node's type-stripping loader does not resolve extensionless
// relative imports, so a static import of any sibling module breaks that path
// while every Bun-run test stays green (2026-09-12: master CI red for three
// runs after a logging import landed here). Runtime dependencies must be
// injected (see registerSlowWriteReporter); only type-only imports may be relative.
describe("sqlite.ts import fence", () => {
    test("has no runtime-relative imports", () => {
        const source = readFileSync(join(import.meta.dir, "sqlite.ts"), "utf8");
        const relativeRuntimeImports = source
            .split("\n")
            .filter((line) => /^import\s+(?!type\s)[^;]*from\s+["']\.\.?\//.test(line));
        expect(relativeRuntimeImports).toEqual([]);
    });
});
