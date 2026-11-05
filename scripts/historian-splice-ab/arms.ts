import { BRANCH_SRC, BASE_SRC } from "./paths";

export interface ProductionArm {
    name: "sanitized" | "unsanitized";
    src: string;
    readSessionChunk: (
        sessionId: string,
        tokenBudget: number,
        offset?: number,
        eligibleEndOrdinal?: number,
        options?: { expandTools?: unknown; expand?: boolean },
    ) => any;
    buildCompartmentAgentPrompt: (inputs: {
        seedExamples: string;
        sessionReferences: string;
        projectMemory: string;
        inputSource: string;
        memoryEnabled?: boolean;
        extractionFree?: boolean;
    }) => string;
    COMPARTMENT_AGENT_SYSTEM_PROMPT: string;
    setRawMessageProvider: (
        sessionId: string,
        provider: { readMessages: () => unknown[]; getMessageCount?: () => number },
    ) => () => void;
}

async function loadArm(name: "sanitized" | "unsanitized", src: string): Promise<ProductionArm> {
    const chunk = await import(`${src}/hooks/magic-context/read-session-chunk.ts`);
    const prompt = await import(`${src}/hooks/magic-context/compartment-prompt.ts`);
    return {
        name,
        src,
        readSessionChunk: chunk.readSessionChunk,
        buildCompartmentAgentPrompt: prompt.buildCompartmentAgentPrompt,
        COMPARTMENT_AGENT_SYSTEM_PROMPT: prompt.COMPARTMENT_AGENT_SYSTEM_PROMPT,
        setRawMessageProvider: chunk.setRawMessageProvider,
    };
}

export async function loadArms(): Promise<{ sanitized: ProductionArm; unsanitized: ProductionArm }> {
    const [sanitized, unsanitized] = await Promise.all([
        loadArm("sanitized", BRANCH_SRC),
        loadArm("unsanitized", BASE_SRC),
    ]);
    return { sanitized, unsanitized };
}
