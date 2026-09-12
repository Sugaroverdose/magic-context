import type { EmbeddingFailure } from "../../features/magic-context/memory/embedding-failure";
import { renderEmbeddingFailure, type UserFacingTextStyle } from "../../shared/user-facing-codes";

export function formatEmbedFailureSummary(
    embedded: number,
    remaining: number,
    failure?: EmbeddingFailure,
    style: UserFacingTextStyle = "markdown",
): string {
    const historyBlocks = `history block${embedded === 1 ? "" : "s"}`;
    const progress = `Indexed ${embedded} ${historyBlocks}; ${remaining} remain.`;
    return `${progress} ${renderEmbeddingFailure(failure?.class ?? "empty_result", style)}`;
}
