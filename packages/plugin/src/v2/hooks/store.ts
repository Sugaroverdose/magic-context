import type { RawMessage } from "../../hooks/magic-context/read-session-raw";
import type { StoreRow } from "../store-reader";

/** The host's seq order, not sortable message IDs, owns ordinal assignment. */
export function rawMessages(rows: readonly StoreRow[]): RawMessage[] {
    return rows
        .filter((row) =>
            ["user", "synthetic", "assistant", "skill", "shell", "system"].includes(row.type),
        )
        .map((row, index) => ({
            id: row.id,
            ordinal: index + 1,
            role: row.type === "assistant" ? "assistant" : "user",
            createdAt: row.data.time?.created,
            parts:
                row.type === "assistant"
                    ? (row.data.content ?? []).map((part) => {
                          if (part.type !== "tool") return { ...part };
                          const state = part.state as Record<string, unknown>;
                          const content = state.content as
                              | Array<{ type: string; text?: string }>
                              | undefined;
                          return {
                              type: "tool",
                              tool: part.name,
                              callID: part.id,
                              state: {
                                  ...state,
                                  output:
                                      content
                                          ?.filter((p) => p.type === "text")
                                          .map((p) => p.text)
                                          .join("\n") ?? "",
                              },
                          };
                      })
                    : [{ type: "text", text: row.data.text ?? "" }],
        }));
}
