import { describe, expect, it } from "bun:test";
import { parse as parseJsonc, stringify as stringifyJsonc } from "comment-json";
import { migrateLegacyAgentEnabledConfigForDoctor } from "./doctor-opencode";

function migrate(input: Record<string, unknown>) {
    const logs: Array<{ level: "success" | "warn"; message: string }> = [];
    const result = migrateLegacyAgentEnabledConfigForDoctor(input, {
        success: (message) => logs.push({ level: "success", message }),
        warn: (message) => logs.push({ level: "warn", message }),
    });
    return { config: input, logs, result };
}

describe("doctor OpenCode legacy agent enabled migration", () => {
    it("migrates legacy enabled fields with conflict rules and warning text", () => {
        const { config, logs, result } = migrate({
            dreamer: { enabled: false, disable: false },
            sidekick: { enabled: true, disable: true },
            historian: { enabled: true, disable: true },
        });

        expect(result).toEqual({ changed: true, fixes: 3 });
        expect(config).toEqual({
            dreamer: { disable: true },
            sidekick: { disable: true },
            historian: { disable: true },
        });
        expect(logs).toContainEqual({
            level: "warn",
            message:
                "Migrated dreamer.enabled=false → dreamer.disable=true. This now also disables manual /ctx-dream. To keep manual dreaming, remove disable=true and set schedule to empty string.",
        });
        expect(logs.map((entry) => entry.message)).toContain(
            "Removed deprecated sidekick.enabled (use sidekick.disable=true to turn off Sidekick).",
        );
        expect(logs.map((entry) => entry.message)).toContain(
            "Removed invalid historian.enabled (historian uses disable=true to turn off).",
        );
    });

    it("removes enabled=true without adding disable=false and is idempotent", () => {
        const first = migrate({ dreamer: { enabled: true }, sidekick: { enabled: false } });
        expect(first.config).toEqual({ dreamer: {}, sidekick: { disable: true } });

        const second = migrate(first.config);
        expect(second.result).toEqual({ changed: false, fixes: 0 });
        expect(second.logs).toEqual([]);
    });

    it("round-trips migrated config through JSONC serialization", () => {
        const config = parseJsonc(
            '{ "dreamer": { "enabled": false }, "sidekick": { "enabled": false } }',
        ) as Record<string, unknown>;
        migrateLegacyAgentEnabledConfigForDoctor(config, { success: () => {}, warn: () => {} });
        const serialized = stringifyJsonc(config, null, 2);

        expect(serialized).toContain('"disable": true');
        expect(serialized).not.toContain('"enabled"');
    });
});
