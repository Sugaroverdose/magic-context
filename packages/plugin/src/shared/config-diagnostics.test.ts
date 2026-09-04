import { beforeEach, describe, expect, it } from "bun:test";

import {
    type ConfigParseFailure,
    claimConfigParseFailuresOnce,
    resetClaimedConfigParseFailuresForTesting,
} from "./config-diagnostics";

const failure: ConfigParseFailure = {
    warningClass: "file-parse",
    source: "user",
    path: "/tmp/magic-context.jsonc",
    line: 1,
    column: 1,
    message: "invalid symbol",
    recovered: true,
    warning: "/tmp/magic-context.jsonc:1:1: invalid symbol",
};

describe("config parse warning notice claims", () => {
    beforeEach(resetClaimedConfigParseFailuresForTesting);

    it("emits each parse failure once per harness surface", () => {
        expect(claimConfigParseFailuresOnce("opencode", [failure])).toEqual([failure]);
        expect(claimConfigParseFailuresOnce("opencode", [failure])).toEqual([]);
        expect(claimConfigParseFailuresOnce("pi", [failure])).toEqual([failure]);
        expect(claimConfigParseFailuresOnce("pi", [failure])).toEqual([]);
    });
});
