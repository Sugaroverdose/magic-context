import { describe, expect, it } from "bun:test";
import { CTX_REDUCE_DESCRIPTION } from "./constants";

describe("ctx-reduce constants", () => {
    //#given
    describe("CTX_REDUCE_DESCRIPTION", () => {
        //#then
        it("should be non-empty", () => {
            expect(CTX_REDUCE_DESCRIPTION.length).toBeGreaterThan(0);
        });

        it("frames reduction as deferred discard, not immediate delete", () => {
            // The contract distinguishes releasing from deletion, explains deferred
            // clearing, and limits releasing to items no longer needed for work ahead.
            expect(CTX_REDUCE_DESCRIPTION).toContain("releasing QUEUES it");
            expect(CTX_REDUCE_DESCRIPTION).toContain("Not a delete");
            expect(CTX_REDUCE_DESCRIPTION).toContain("no longer needs");
            // No scarcity/rm framing that makes models over-conservative.
            expect(CTX_REDUCE_DESCRIPTION).not.toContain("gone forever");
            expect(CTX_REDUCE_DESCRIPTION).not.toContain("Remove entirely");
        });

        it("teaches the copy-handle grammar, never numeric stamps", () => {
            expect(CTX_REDUCE_DESCRIPTION).toContain("toolcall_ids");
            expect(CTX_REDUCE_DESCRIPTION).toContain("msg_samples");
            expect(CTX_REDUCE_DESCRIPTION).toContain("copied exactly");
            expect(CTX_REDUCE_DESCRIPTION).toContain("slot for slot");
            expect(CTX_REDUCE_DESCRIPTION).not.toContain("§");
            expect(CTX_REDUCE_DESCRIPTION).not.toContain("drop");
        });
    });
});
