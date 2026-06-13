import { describe, expect, it } from "bun:test";
import { getAvailableModels, parseModelListOutput } from "./pi-helpers";

describe("parseModelListOutput", () => {
    it("parses the `pi --list-models` table (provider + model columns) — issue #144", () => {
        // Real `pi --list-models` shape: fixed-width table, provider and model
        // in SEPARATE columns (no slash). The old parser required each token to
        // contain `/`, matched zero rows, and fell back to a hardcoded model
        // list the user didn't have.
        const output = [
            "provider      model                context  max-out  thinking  images",
            "anthropic     claude-fable-5       1M       128K     yes       yes",
            "anthropic     claude-opus-4-8      1M       128K     yes       yes",
            "openai-codex  gpt-5.5              400K     128K     yes       yes",
            "opencode-go   kimi-k2.6            262.1K   65.5K    yes       yes",
            "opencode-go   qwen3.7-max          1M       128K     yes       no",
        ].join("\n");

        expect(parseModelListOutput(output)).toEqual([
            "anthropic/claude-fable-5",
            "anthropic/claude-opus-4-8",
            "openai-codex/gpt-5.5",
            "opencode-go/kimi-k2.6",
            "opencode-go/qwen3.7-max",
        ]);
    });

    it("skips the header row", () => {
        const models = parseModelListOutput("provider  model\nanthropic  claude-opus-4-8");
        expect(models).toEqual(["anthropic/claude-opus-4-8"]);
    });

    it("still accepts a pre-joined provider/model first token (forward-compat)", () => {
        const output = [
            "anthropic/claude-opus-4-8  1M  yes",
            "openai-codex/gpt-5.5  400K  yes",
        ].join("\n");
        expect(parseModelListOutput(output)).toEqual([
            "anthropic/claude-opus-4-8",
            "openai-codex/gpt-5.5",
        ]);
    });

    it("ignores usage lines, URLs, and blank lines", () => {
        const output = [
            "Usage: pi --list-models",
            "",
            "anthropic  claude-opus-4-8",
            "https://example.com/docs",
        ].join("\n");
        expect(parseModelListOutput(output)).toEqual(["anthropic/claude-opus-4-8"]);
    });

    it("dedupes repeated ids", () => {
        const output = "anthropic  claude-opus-4-8\nanthropic  claude-opus-4-8";
        expect(parseModelListOutput(output)).toEqual(["anthropic/claude-opus-4-8"]);
    });

    it("strips ANSI color codes before parsing", () => {
        const esc = String.fromCharCode(27);
        const output = `${esc}[32manthropic${esc}[0m  claude-opus-4-8`;
        expect(parseModelListOutput(output)).toEqual(["anthropic/claude-opus-4-8"]);
    });
});

describe("getAvailableModels", () => {
    it("returns [] when pi output parses to no models (no static fallback)", () => {
        const piPath = process.platform === "win32" ? "where" : "true";
        expect(getAvailableModels(piPath)).toEqual([]);
    });
});
