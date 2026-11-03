import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { UserMemory } from "../../features/magic-context/user-memory/storage-user-memory";
import { renderM0 } from "./inject-compartments";
import { renderUserProfileContent, USER_PROFILE_DESCRIPTION } from "./user-profile-render";

interface UserProfileRenderFixture {
    block_description?: string;
    cases: Array<{ input: string; expected: string }>;
}

const fixture = JSON.parse(
    readFileSync(
        resolve(import.meta.dir, "../../../../../tests/fixtures/user-profile-render.json"),
        "utf8",
    ),
) as UserProfileRenderFixture;

function profile(cases: string[]): UserMemory[] {
    return cases.map((input, index) => ({
        id: index + 1,
        content: input,
        status: "active",
        promotedAt: 0,
        sourceCandidateIds: [],
        sourceProvenance: null,
        createdAt: 0,
        updatedAt: 0,
    }));
}

describe("user-profile content rendering", () => {
    it("matches the shared Rust/TypeScript fixture", () => {
        for (const { input, expected } of fixture.cases) {
            expect(renderUserProfileContent(input)).toBe(expected);
        }

        const rendered = renderM0({
            projectDocs: "",
            userProfileBaseline: profile(fixture.cases.map(({ input }) => input)),
            compartments: [],
            memories: [],
            facts: [],
            userProfileBudgetTokens: 10_000,
        });
        const expectedBlock = [
            "<user-profile>",
            USER_PROFILE_DESCRIPTION,
            ...fixture.cases.map(({ expected }) => `- ${expected}`),
            "</user-profile>",
        ].join("\n");
        expect(rendered).toContain(expectedBlock);
    });
});

describe("user-profile self-description laws", () => {
    it("the block starts with the description directly after the opening tag (law: description-first)", () => {
        const rendered = renderM0({
            projectDocs: "",
            userProfileBaseline: profile(["User strongly pushes back on untested changes."]),
            compartments: [],
            memories: [],
            facts: [],
            userProfileBudgetTokens: 10_000,
        });
        const blockIndex = rendered.indexOf("<user-profile>");
        expect(blockIndex).toBeGreaterThanOrEqual(0);
        const lines = rendered.slice(blockIndex).split("\n");
        expect(lines[1]).toBe(USER_PROFILE_DESCRIPTION);
        expect(lines[2]).toBe("- Strongly pushes back on untested changes.");
    });

    it("an empty store renders no user-profile block at all — no orphan header (law: empty-store)", () => {
        const rendered = renderM0({
            projectDocs: "",
            userProfileBaseline: [],
            compartments: [],
            memories: [],
            facts: [],
            userProfileBudgetTokens: 10_000,
        });
        expect(rendered).not.toContain("<user-profile>");
    });

    it("the description matches the shared Rust/TypeScript fixture (cross-harness sync law)", () => {
        expect(fixture.block_description).toBeDefined();
        expect(USER_PROFILE_DESCRIPTION).toBe(fixture.block_description);
    });
});
