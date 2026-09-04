export const CONFIG_WARNING_CLASS = {
    FILE_PARSE: "file-parse",
    FILE_IO: "file-io",
    INVALID_LEAF: "invalid-leaf",
} as const;

export type ConfigWarningClass = (typeof CONFIG_WARNING_CLASS)[keyof typeof CONFIG_WARNING_CLASS];

export interface ConfigParseFailure {
    warningClass: typeof CONFIG_WARNING_CLASS.FILE_PARSE;
    source: "user" | "project";
    path: string;
    line: number;
    column: number;
    message: string;
    recovered: boolean;
    warning: string;
}

export interface ConfigWarningDetail {
    warningClass: ConfigWarningClass;
    source?: "user" | "project";
    path?: string;
    line?: number;
    column?: number;
    message: string;
}

export function formatConfigParseStatusLine(failure: ConfigParseFailure): string {
    const disposition = failure.recovered
        ? "recovered values applied; fix the file"
        : "running on defaults";
    return `Config: PARSE FAILED (${failure.path}:${failure.line}:${failure.column}) — ${disposition}`;
}

export function formatConfigParseNotice(failures: readonly ConfigParseFailure[]): string {
    const lines = failures.map(
        (failure) => `${formatConfigParseStatusLine(failure)}\n${failure.message}`,
    );
    return ["⚠️ Magic Context config parse failure", ...lines].join("\n\n");
}

const claimedFailures = new Set<string>();

function failureKey(surface: string, failure: ConfigParseFailure): string {
    return `${surface}\0${failure.path}\0${failure.line}\0${failure.column}\0${failure.message}`;
}

/** Claim parse-failure notices once for each runtime surface in this process. */
export function claimConfigParseFailuresOnce(
    surface: "opencode" | "pi",
    failures: readonly ConfigParseFailure[],
): ConfigParseFailure[] {
    return failures.filter((failure) => {
        const key = failureKey(surface, failure);
        if (claimedFailures.has(key)) return false;
        claimedFailures.add(key);
        return true;
    });
}

export function resetClaimedConfigParseFailuresForTesting(): void {
    claimedFailures.clear();
}
