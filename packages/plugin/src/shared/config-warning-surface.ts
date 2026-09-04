import type { ConfigParseFailure } from "./config-diagnostics";
import { formatConfigParseStatusLine } from "./config-diagnostics";

export function buildOpenCodeConfigWarningBanner(
    warnings: readonly string[],
    parseFailures: readonly ConfigParseFailure[],
    allParseFailures: readonly ConfigParseFailure[] = parseFailures,
): string {
    const parseWarningStrings = new Set(allParseFailures.map((failure) => failure.warning));
    const ordinaryWarnings = warnings.filter(
        (warning) =>
            ![...parseWarningStrings].some((parseWarning) => warning.includes(parseWarning)),
    );
    const entries = [
        ...parseFailures.map(
            (failure) =>
                `- **TOP SEVERITY:** ${formatConfigParseStatusLine(failure)} — ${failure.message}`,
        ),
        ...ordinaryWarnings.map((warning) => `- ${warning}`),
    ];
    return [
        "## ⚠️ Magic Context Config Warning",
        "",
        ...entries,
        "",
        "Fix the reported `magic-context.jsonc` file; Magic Context remains enabled.",
    ].join("\n");
}
