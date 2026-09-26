import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { V2_MEMORY_CATEGORIES } from "./constants";

const root = resolve(import.meta.dir, "../../../../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const names = [...V2_MEMORY_CATEGORIES];

describe("historian category vocabulary drift", () => {
    it("keeps the source and emitted prompt category headings and tags in sync", () => {
        for (const path of [
            "packages/plugin/src/hooks/magic-context/historian-prompt.source.md",
            "crates/mc-module/testdata/historian-system-prompt.txt",
        ]) {
            const text = read(path);
            expect([...text.matchAll(/^#### `([A-Z][A-Z0-9_]*)`$/gm)].map((m) => m[1])).toEqual(
                names,
            );
            expect([...text.matchAll(/^<([A-Z][A-Z0-9_]*)>$/gm)].map((m) => m[1])).toEqual(names);
        }
    });

    it("keeps the Rust parser's vendored category list in sync", () => {
        const rust = read("crates/mc-module/src/historian_validate.rs");
        const list = rust.match(/const HISTORIAN_CATEGORIES: &\[&str\] = &\[([^\]]+)\];/)?.[1];
        expect(list).toBeDefined();
        expect([...list!.matchAll(/"([A-Z][A-Z0-9_]*)"/g)].map((m) => m[1])).toEqual(names);
    });
});
