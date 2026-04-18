import { log } from "../shared/logger";

type MessageWithParts = {
    info: import("@opencode-ai/sdk").Message;
    parts: import("@opencode-ai/sdk").Part[];
};

type MessagesTransformOutput = { messages: MessageWithParts[] };

/**
 * Top-level transform wrapper. Swallows any unexpected error (typically
 * SQLITE_BUSY from concurrent plugin processes) so OpenCode's prompt loop
 * always proceeds. Without this guard, a transient DB contention event can
 * crash the user's turn through OpenCode's Effect pipeline — see issue #23
 * https://github.com/cortexkit/opencode-magic-context/issues/23
 *
 * On failure, the messages array is returned unmodified (i.e., magic-context
 * manipulation is skipped for this pass). The next transform pass will
 * retry with normal behavior. Correctness is preserved because all
 * persistent state mutations are idempotent across passes.
 */
export function createMessagesTransformHandler(args: {
    magicContext: {
        "experimental.chat.messages.transform"?: (
            input: Record<string, never>,
            output: MessagesTransformOutput,
        ) => Promise<void>;
    } | null;
}): (input: Record<string, never>, output: MessagesTransformOutput) => Promise<void> {
    return async (input, output): Promise<void> => {
        try {
            await args.magicContext?.["experimental.chat.messages.transform"]?.(input, output);
        } catch (error) {
            const code = (error as { code?: string } | null)?.code;
            const name = (error as { name?: string } | null)?.name;
            const message = error instanceof Error ? error.message : String(error);
            log(
                `[magic-context] transform failed (code=${code ?? "none"} name=${name ?? "none"}): ${message}. Continuing with unmodified messages for this pass.`,
                error,
            );
            // Do NOT rethrow — OpenCode's Effect pipeline turns thrown errors into
            // user-visible prompt failures. We accept degraded behavior (no
            // injection / no drops this turn) rather than blocking the user.
        }
    };
}
