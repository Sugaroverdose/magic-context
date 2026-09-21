export interface CountMeasurement {
    systemApi: number;
    toolsApi: number;
    proseApi: number;
    sections: Record<string, number>;
    method: string;
}

export type CountAdapter = (model: string, key: string, system: string, tools: unknown[], prose: Record<string, string>) => Promise<CountMeasurement>;

/** Keep response bodies out of logs: providers may echo request data in errors. */
export async function postCountJson(url: string, headers: Record<string, string>, body: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(url, {
        method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`${new URL(url).pathname} HTTP ${response.status} (${response.status === 404 ? "model or endpoint unavailable" : response.status === 401 || response.status === 403 ? "credentials or model access refused" : "request rejected"})`);
    return await response.json() as Record<string, unknown>;
}

export function requireCount(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Endpoint returned no valid token count");
    return value;
}

export function functionTools(tools: unknown[]) {
    return (tools as Array<Record<string, unknown>>).map((tool) => ({
        name: tool.name, description: tool.description, parameters: tool.input_schema,
    }));
}

/** Count full request envelopes, subtracting the same minimal-user baseline. */
export async function measureRequests(
    method: string,
    count: (probe: { system?: string; tools?: boolean; user: string }) => Promise<number>,
    system: string,
    prose: Record<string, string>,
): Promise<CountMeasurement> {
    const baseline = await count({ user: "x" });
    const subtract = async (probe: { system?: string; tools?: boolean; user: string }) => {
        const delta = await count(probe) - baseline;
        if (delta < 0) throw new Error("Probe count below baseline");
        return delta;
    };
    const systemApi = await subtract({ system, user: "x" });
    const toolsApi = await subtract({ tools: true, user: "x" });
    const proseApi = await subtract({ user: `x\n${Object.values(prose).join("\n\n")}` });
    const sections: Record<string, number> = {};
    for (const [name, text] of Object.entries(prose)) sections[name] = await subtract({ user: `x\n${text}` });
    return { method, systemApi, toolsApi, proseApi, sections };
}
