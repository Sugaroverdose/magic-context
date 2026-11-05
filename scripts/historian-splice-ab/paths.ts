export const BRANCH_ROOT = "/Users/Sugaroverdose/.paseo/worktrees/0j6h2a6r/fix-historian-splice-sanitize";
export const BASE_ROOT = "/var/folders/0j/695gfmss4qb3b64m2_7lxzh40000gn/T/opencode/mc-historian-ab/base-42d0a764b";

export const BRANCH_SRC = `${BRANCH_ROOT}/packages/plugin/src`;
export const BASE_SRC = `${BASE_ROOT}/packages/plugin/src`;

export const HOST_DB = `${process.env.HOME}/.local/share/opencode/opencode.db`;
export const CONTEXT_DB = `${process.env.HOME}/.local/share/cortexkit/magic-context/context.db`;
export const STATION_BASE_URL = "http://station.hq.pe:8080/v1";
export const STATION_MODEL = "qwen3.8-flash-next";
export const STATION_MODEL_KEY = "station/qwen3.8-flash-next";
export const ARTIFACTS_DIR = `${BRANCH_ROOT}/scripts/historian-splice-ab/artifacts`;

export const HISTORIAN_SAMPLING = { temperature: 0.7, top_p: 0.8, max_tokens: 16384 };

export function censusJsonPath(artifactsDir: string): string {
    return `${artifactsDir}/census/census.json`;
}
