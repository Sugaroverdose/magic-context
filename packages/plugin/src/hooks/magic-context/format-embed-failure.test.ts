import { describe, expect, test } from "bun:test";
import type { EmbeddingFailure } from "../../features/magic-context/memory/embedding-failure";
import { formatEmbedFailureSummary } from "./format-embed-failure";

const failures: EmbeddingFailure[] = [
    {
        class: "substitution_rejected",
        reason: "served model 'bge-m3' does not match requested 'baai/bge-m3-embedding' (substitution guard)",
        retryable: false,
    },
    {
        class: "http_error",
        reason: "HTTP 402 from endpoint: quota exhausted",
        retryable: false,
    },
    {
        class: "empty_result",
        reason: "response data[] was empty",
        retryable: true,
    },
    {
        class: "invalid_envelope",
        reason: "response had keys [object, results] but data[] was absent",
        retryable: false,
    },
    {
        class: "certification_refusal",
        reason: "SYNAPSE certification refused embedding: not_certified",
        retryable: false,
    },
    {
        class: "local_binding_missing",
        reason: "onnxruntime-node has no darwin/x64 native binding and the WASM fallback could not complete",
        retryable: false,
    },
    {
        class: "local_fs_unavailable",
        reason: "the WASM model cache cannot access the Node filesystem",
        retryable: false,
    },
    {
        class: "local_download_failure",
        reason: "the embedding model download failed: fetch failed",
        retryable: true,
    },
    {
        class: "local_runtime_error",
        reason: "the local embedding runtime failed: session creation failed",
        retryable: false,
    },
];

describe("formatEmbedFailureSummary", () => {
    test.each(failures)("maps $class to a stable code without provider detail", (failure) => {
        const summary = formatEmbedFailureSummary(0, 193, failure);
        expect(summary).toMatch(/\(MC-E\d{2}\)$/);
        expect(summary).toContain("Indexed 0 history blocks; 193 remain.");
        expect(summary).not.toContain(failure.reason);
    });

    test("keeps local runtime details out of the user-facing result", () => {
        const raw =
            "onnxruntime-node has no darwin/x64 native binding and the WASM fallback could not complete";
        const summary = formatEmbedFailureSummary(0, 7, {
            class: "local_binding_missing",
            reason: raw,
            retryable: false,
        });

        expect(summary).toContain("Local search indexing is unavailable on this system.");
        expect(summary).toContain("Run `npx @cortexkit/magic-context doctor`, then retry.");
        expect(summary).toContain("(MC-E08)");
        expect(summary).not.toContain(raw);

        const plain = formatEmbedFailureSummary(
            0,
            7,
            { class: "local_binding_missing", reason: raw, retryable: false },
            "plain",
        );
        expect(plain).toContain("Run npx @cortexkit/magic-context doctor, then retry.");
        expect(plain).not.toContain("`");
    });

    test("uses the structured certification class rather than its provider text", () => {
        const raw = "SYNAPSE certification refused embedding: not_certified";
        const summary = formatEmbedFailureSummary(0, 193, {
            class: "certification_refusal",
            reason: raw,
            retryable: false,
        });

        expect(summary).toContain("(MC-E06)");
        expect(summary).not.toContain(raw);
    });
});
