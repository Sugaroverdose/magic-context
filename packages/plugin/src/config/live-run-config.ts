import { loadPluginConfigDetailed, type MagicContextPluginConfig } from "./index";
import { LiveConfigReader } from "./live-snapshot";
import type { MagicContextConfig } from "./schema/magic-context";

/**
 * Refresh only historian producer settings. Prompt-rendering and agent-registration
 * settings retain their boot values until those consumers can safely reload them.
 */
export function historianRunConfig<T extends MagicContextConfig>(boot: T, fresh: T): T {
    return {
        ...boot,
        historian_timeout_ms: fresh.historian_timeout_ms,
        historian: {
            ...boot.historian,
            opencode: fresh.historian?.opencode,
            pi: fresh.historian?.pi,
            omp: fresh.historian?.omp,
            temperature: fresh.historian?.temperature,
            two_pass: fresh.historian?.two_pass ?? false,
        },
    };
}

export function dreamerRunConfig<T extends MagicContextConfig>(boot: T, fresh: T): T {
    return {
        ...boot,
        mural: { ...boot.mural, model: fresh.mural.model },
        memory: {
            ...boot.memory,
            auto_promote: fresh.memory.auto_promote,
            retrieval_count_promotion_threshold: fresh.memory.retrieval_count_promotion_threshold,
            git_commit_indexing: fresh.memory.git_commit_indexing,
        },
        dreamer: boot.dreamer
            ? {
                  ...boot.dreamer,
                  temperature: fresh.dreamer?.temperature,
                  top_p: fresh.dreamer?.top_p,
                  opencode: fresh.dreamer?.opencode,
                  pi: fresh.dreamer?.pi,
                  omp: fresh.dreamer?.omp,
                  tasks: fresh.dreamer?.tasks ?? boot.dreamer.tasks,
              }
            : boot.dreamer,
    };
}

const pluginReaders = new Map<string, LiveConfigReader<MagicContextPluginConfig>>();

/** Shared by all OpenCode entry points for one project in this process. */
export function pluginConfigReader(directory: string, boot: MagicContextPluginConfig) {
    let reader = pluginReaders.get(directory);
    if (!reader) {
        reader = new LiveConfigReader(directory, boot, () => {
            const loaded = loadPluginConfigDetailed(directory, false);
            if (loaded.loadOutcome === "project-file-parse-error" || loaded.loadOutcome === "project-file-io-error" || loaded.loadOutcome === "schema-recovery") {
                throw new Error(`invalid configuration: ${loaded.config.configWarnings?.join("; ") ?? loaded.loadOutcome}`);
            }
            return loaded.config;
        });
        reader.poll();
        pluginReaders.set(directory, reader);
    }
    return reader;
}
