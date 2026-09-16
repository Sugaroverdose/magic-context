/// <reference types="bun-types" />

import { afterEach, expect, test } from "bun:test";
import plugin from "../index";
import { _resetHarnessForTesting, getHarness, setHarness } from "../shared/harness";
import { isOpenCode2HostContext, setup } from "./server";

afterEach(() => {
    _resetHarnessForTesting();
});

const openCode11830SetupContext = {
    options: {},
    agent: {},
    aisdk: {},
    catalog: {},
    command: {},
    integration: {},
    plugin: {},
    reference: {},
    skill: {},
};

test("setup() with the OpenCode 1.18.30 context shape stays inert and does not lock opencode2", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
    };
    try {
        const dispose = await setup(openCode11830SetupContext as never);
        expect(isOpenCode2HostContext(openCode11830SetupContext)).toBe(false);
        expect(getHarness()).toBe("opencode");
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("v2 setup is inert");
        await dispose();
        expect(getHarness()).toBe("opencode");
    } finally {
        console.warn = originalWarn;
    }
});

test("setup() with session.hook locks the v2 harness", async () => {
    const context = {
        session: { hook: async () => {} },
    };
    expect(isOpenCode2HostContext(context)).toBe(true);
    try {
        await setup(context as never);
    } catch {
        // registerContext needs a full v2 host; the harness lock is the contract.
    }
    expect(getHarness()).toBe("opencode2");
});

test("server() after a foreign harness lock throws instead of mis-tagging", async () => {
    setHarness("opencode2");
    await expect(
        plugin.server({ directory: "/tmp/mc-opencode2-harness-lock" } as never),
    ).rejects.toThrow(/harness already locked to "opencode2"; cannot change to "opencode"/);
    expect(getHarness()).toBe("opencode2");
});
