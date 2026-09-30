import type { SmartNoteCheckManifest } from "./types";

/**
 * Accept "a tag on OWNER/REPO that isn't an ancestor of BASE, or a tag
 * other than A/B exists". Compile this form without a language model so it
 * enumerates all tags and excludes both allowed names, rather than checking
 * only the nearest tag or using the always-true expression name !== A || name !== B.
 */
export function compileTagSetCondition(condition: string): {
    compiled_check: string;
    manifest: SmartNoteCheckManifest;
    check_cron: string;
} | null {
    const match = condition
        .trim()
        .match(
            /^a tag on ([\w.-]+\/[\w.-]+) that (?:isn't|is not) an ancestor of ([\w./-]+),? or a tag other than ([\w./-]+)\/([\w.-]+) exists[.]?$/i,
        );
    if (!match) return null;
    const [, repository, base, first, second] = match;
    const root = `https://api.github.com/repos/${repository}`;
    const pages = Array.from(
        { length: 10 },
        (_, index) => `${root}/tags?per_page=100&page=${index + 1}`,
    );
    const comparisons = [first, second].map(
        (tag) =>
            `${root}/compare/${encodeURIComponent(base)}...${encodeURIComponent(tag)}?per_page=1`,
    );
    return {
        compiled_check: `function check(cap) {
    var pages = ${JSON.stringify(pages)};
    var allowed = ${JSON.stringify([first, second])};
    var comparisons = ${JSON.stringify(comparisons)};
    for (var page = 0; page < pages.length; page++) {
        var response = cap.httpGet(pages[page]);
        if (response.status !== 200) throw new Error("Cannot enumerate tags: HTTP " + response.status);
        var tags = JSON.parse(response.body);
        if (!Array.isArray(tags)) throw new Error("Invalid tag list");
        for (var i = 0; i < tags.length; i++) {
            var tag = tags[i];
            if (!tag || typeof tag.name !== "string") throw new Error("Invalid tag name");
            if (allowed.indexOf(tag.name) === -1) return { met: true };
            var comparison = cap.httpGet(comparisons[allowed.indexOf(tag.name)]);
            if (comparison.status !== 200) throw new Error("Cannot check ancestry: HTTP " + comparison.status);
            var status = JSON.parse(comparison.body).status;
            if (status === "ahead" || status === "diverged") return { met: true };
            if (status !== "behind" && status !== "identical") throw new Error("Invalid ancestry comparison");
        }
        if (tags.length < 100) return { met: false };
    }
    throw new Error("Tag pagination exceeded 1000 tags; condition cannot be checked completely");
}`,
        manifest: {
            capabilities: ["httpGet"],
            hosts: ["api.github.com"],
            urls: [...pages, ...comparisons],
            summary:
                "Enumerate tags, exclude allowed names, and compare each allowed tag to the base",
        },
        check_cron: "0 * * * *",
    };
}
