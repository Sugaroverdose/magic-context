import { BRANCH_SRC } from "./paths";
import { openContextDbRo } from "./db";

export interface SessionFit {
    chunkTokens: number;
    seedExamples: string;
    sessionReferences: string;
    projectMemory: string;
    kept: unknown;
    trimmed: boolean;
}

let cached: {
    fitHistorianPrompt: any;
    resolveHistorianProducerWindow: any;
    producerSourceLocalBudget: any;
    deriveHistorianChunkTokens: any;
    resolveHistorianContextLimit: any;
    COMPARTMENT_AGENT_SYSTEM_PROMPT: string;
    getCompartments: any;
    getMemoriesByProject: any;
    resolveProjectIdentity: any;
} | null = null;

async function production() {
    if (!cached) {
        const [fitMod, budgetMod, promptMod, compStor, memStor, projIdent] = await Promise.all([
            import(`${BRANCH_SRC}/hooks/magic-context/historian-prompt-fit.ts`),
            import(`${BRANCH_SRC}/hooks/magic-context/derive-budgets.ts`),
            import(`${BRANCH_SRC}/hooks/magic-context/compartment-prompt.ts`),
            import(`${BRANCH_SRC}/features/magic-context/compartment-storage.ts`),
            import(`${BRANCH_SRC}/features/magic-context/memory/storage-memory.ts`),
            import(`${BRANCH_SRC}/features/magic-context/memory/project-identity.ts`),
        ]);
        cached = {
            fitHistorianPrompt: fitMod.fitHistorianPrompt,
            resolveHistorianProducerWindow: fitMod.resolveHistorianProducerWindow,
            producerSourceLocalBudget: budgetMod.producerSourceLocalBudget,
            deriveHistorianChunkTokens: budgetMod.deriveHistorianChunkTokens,
            resolveHistorianContextLimit: budgetMod.resolveHistorianContextLimit,
            COMPARTMENT_AGENT_SYSTEM_PROMPT: promptMod.COMPARTMENT_AGENT_SYSTEM_PROMPT,
            getCompartments: compStor.getCompartments,
            getMemoriesByProject: memStor.getMemoriesByProject,
            resolveProjectIdentity: projIdent.resolveProjectIdentity,
        };
    }
    return cached;
}

export async function requestedChunkTokensFor(modelKey: string): Promise<number> {
    const p = await production();
    const providerTokens = p.deriveHistorianChunkTokens(p.resolveHistorianContextLimit(modelKey));
    return p.producerSourceLocalBudget(providerTokens, modelKey);
}

/** Production historian prompt fit for a session window, from real context.db state. */
export async function fitSessionWindow(args: {
    sessionId: string;
    directory: string;
    chunkStart: number;
    lastOrdinal: number;
    modelKey: string;
    maxOutputTokens: number;
}): Promise<SessionFit> {
    const p = await production();
    const db = openContextDbRo() as any;
    try {
        const priorCompartments = p.getCompartments(db, args.sessionId);
        const projectPath = p.resolveProjectIdentity(args.directory);
        const memories = p.getMemoriesByProject(db, projectPath, ["active", "permanent"]);
        const window = p.resolveHistorianProducerWindow(args.modelKey, args.maxOutputTokens, undefined);
        const requested = await requestedChunkTokensFor(args.modelKey);
        const fit = p.fitHistorianPrompt({
            window,
            systemPrompt: p.COMPARTMENT_AGENT_SYSTEM_PROMPT,
            requestedChunkTokens: requested,
            sessionId: args.sessionId,
            chunkStart: args.chunkStart,
            lastOrdinal: args.lastOrdinal,
            sessionCompartments: priorCompartments,
            memories,
            memoryEnabled: true,
        });
        if (!fit.ok) throw new Error(`prompt fit failed: ${fit.reason}`);
        return {
            chunkTokens: fit.chunkTokens,
            seedExamples: fit.seedExamples,
            sessionReferences: fit.sessionReferences,
            projectMemory: fit.projectMemory,
            kept: fit.kept,
            trimmed: fit.trimmed,
        };
    } finally {
        db.close();
    }
}
