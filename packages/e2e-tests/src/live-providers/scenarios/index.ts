import type { ScenarioSpec } from "../types";
import { scenarios as bedrock } from "./bedrock";
import { scenarios as deepseek } from "./deepseek";
import { scenarios as kimi } from "./kimi";
import { scenarios as openai } from "./openai";
import { scenarios as openrouter } from "./openrouter";

/** Every live scenario, keyed `<route id>:<kind>` for `--only`. */
export const ALL_SCENARIOS: ScenarioSpec[] = [...openai, ...bedrock, ...openrouter, ...deepseek, ...kimi];

export const scenarioId = (spec: ScenarioSpec) => `${spec.route.id}:${spec.kind}`;
