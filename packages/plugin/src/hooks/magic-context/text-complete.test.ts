import { describe, expect, it } from "bun:test";

import { createTextCompleteHandler } from "./text-complete";

const SECTION = "\u00a7"; // U+00A7, the section sign character used in MC tag prefixes.

describe("text-complete handler", () => {
    // ctx_reduce v1 ruling: the completion boundary persists the model's
    // bytes verbatim. Nothing cuts tag notation, globally or locally — the
    // notation is no longer primed as plugin behavior, so anything carrying
    // it (legacy residue, model prose) is content the model owns.
    const verbatimCases: Array<[string, string]> = [
        ["leading §N§ prefix", `${SECTION}42${SECTION} Hello world`],
        [
            "consecutive different leading tags",
            `${SECTION}55${SECTION} ${SECTION}56${SECTION} Response text`,
        ],
        [
            "double identical leading tags",
            `${SECTION}56${SECTION} ${SECTION}56${SECTION} Bailan Kimi 2.5 done`,
        ],
        ["large tag number", `${SECTION}999${SECTION} Large tag content`],
        ["prefix without trailing space", `${SECTION}42${SECTION}Response without space`],
        ["mid-text §N§ pair", `Looking at ${SECTION}40827${SECTION} the result is X`],
        ['mid-text malformed §N"> hybrid', `Hello ${SECTION}40827">Oracle confirmed`],
        ["stray § character", `See ${SECTION} marker for details`],
        [
            "leading prefix + mid-text pair",
            `${SECTION}42${SECTION} The pattern ${SECTION}40827${SECTION} appeared.`,
        ],
        [
            "multiple mid-text pairs",
            `First ${SECTION}100${SECTION}, then ${SECTION}200${SECTION}, finally ${SECTION}300${SECTION}.`,
        ],
        ["§-prefixed section reference", `As described in ${SECTION}5.1 of the plan`],
        ["repeated well-formed prefixes", `${SECTION}2030${SECTION} ${SECTION}2030${SECTION} Run`],
    ];

    describe("persistence boundary: verbatim", () => {
        for (const [name, text] of verbatimCases) {
            it(`#given ${name} #when handler runs #then bytes persist unchanged`, async () => {
                const handler = createTextCompleteHandler();

                const output = { text };

                await handler({ sessionID: "s1", messageID: "m1", partID: "p1" }, output);

                expect(output.text).toBe(text);
            });
        }
    });

    describe("bare digit residue (no § — not stripped at persistence)", () => {
        it("#given accumulated digit residue without § #when handler runs #then preserves digits", async () => {
            const handler = createTextCompleteHandler();

            const output = { text: `2030  2030  2030\u00b0 Run clippy` };

            await handler({ sessionID: "s1", messageID: "m1", partID: "p1" }, output);

            expect(output.text).toBe(`2030  2030  2030\u00b0 Run clippy`);
        });

        it("#given short leading tag-like numbers #when handler runs #then preserves them", async () => {
            const handler = createTextCompleteHandler();

            const output = { text: "99  Actually executing now. Running fmt:" };

            await handler({ sessionID: "s1", messageID: "m1", partID: "p1" }, output);

            expect(output.text).toBe("99  Actually executing now. Running fmt:");
        });
    });

    describe("no-op cases", () => {
        it("#given plain text without any § #when handler runs #then text is unchanged", async () => {
            const handler = createTextCompleteHandler();

            const output = { text: "No tag here, just normal text" };

            await handler({ sessionID: "s1", messageID: "m1", partID: "p1" }, output);

            expect(output.text).toBe("No tag here, just normal text");
        });

        it("#given empty text #when handler runs #then stays empty", async () => {
            const handler = createTextCompleteHandler();

            const output = { text: "" };

            await handler({ sessionID: "s1", messageID: "m1", partID: "p1" }, output);

            expect(output.text).toBe("");
        });
    });
});
