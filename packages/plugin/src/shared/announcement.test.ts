import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * `announcement.ts` reads/writes a single `last_announced_version` file under
 * `getMagicContextStorageDir()`. The behavior we test:
 *   1. `markAnnouncementSeen` then `readLastAnnouncedVersion` round-trips
 *   2. `shouldShowAnnouncement` returns false after a matching mark
 *   3. `shouldShowAnnouncement` returns true after a non-matching mark
 *   4. Empty-version inputs are no-ops (don't crash, don't write garbage)
 *
 * We isolate writes by pointing `XDG_DATA_HOME` at a temp dir before requiring
 * the module fresh per test, since the module captures the storage path at
 * import time via `getMagicContextStorageDir()`.
 */

let tmpRoot = "";
let originalXdg: string | undefined;

beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-announcement-test-"));
    originalXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = tmpRoot;
});

afterEach(() => {
    if (originalXdg === undefined) {
        delete process.env.XDG_DATA_HOME;
    } else {
        process.env.XDG_DATA_HOME = originalXdg;
    }
    try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
        // best-effort
    }
});

describe("announcement state persistence", () => {
    test("round-trips a dismissed version through the file", async () => {
        // Fresh import after XDG override so the module captures the temp path
        const mod = await import(`./announcement?t=${Date.now()}-rt`);
        const { readLastAnnouncedVersion, markAnnouncementSeen } = mod;

        expect(readLastAnnouncedVersion()).toBe("");

        markAnnouncementSeen("9.9.9");
        expect(readLastAnnouncedVersion()).toBe("9.9.9");

        markAnnouncementSeen("9.9.10");
        expect(readLastAnnouncedVersion()).toBe("9.9.10");
    });

    test("ignores empty / zero-length version marks", async () => {
        const mod = await import(`./announcement?t=${Date.now()}-empty`);
        const { readLastAnnouncedVersion, markAnnouncementSeen } = mod;

        markAnnouncementSeen("");
        expect(readLastAnnouncedVersion()).toBe("");
    });

    test("creates the storage directory if it does not exist", async () => {
        const mod = await import(`./announcement?t=${Date.now()}-mkdir`);
        const { markAnnouncementSeen } = mod;

        // Storage dir lives under tmpRoot + cortexkit/magic-context — does not
        // exist yet at the start of the test
        const expectedDir = path.join(tmpRoot, "cortexkit", "magic-context");
        expect(fs.existsSync(expectedDir)).toBe(false);

        markAnnouncementSeen("0.21.7");

        expect(fs.existsSync(expectedDir)).toBe(true);
        expect(fs.readFileSync(path.join(expectedDir, "last_announced_version"), "utf-8")).toBe(
            "0.21.7",
        );
    });

    test("trims whitespace from stored version on read", async () => {
        const mod = await import(`./announcement?t=${Date.now()}-trim`);
        const { readLastAnnouncedVersion } = mod;

        const dir = path.join(tmpRoot, "cortexkit", "magic-context");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "last_announced_version"), "  1.2.3  \n");

        expect(readLastAnnouncedVersion()).toBe("1.2.3");
    });
});

describe("shouldShowAnnouncement gating", () => {
    test("returns false when the live version is already marked", async () => {
        const mod = await import(`./announcement?t=${Date.now()}-match`);
        const {
            ANNOUNCEMENT_VERSION,
            ANNOUNCEMENT_FEATURES,
            markAnnouncementSeen,
            shouldShowAnnouncement,
        } = mod;

        // Skip the test if announcements are currently disabled (empty constants)
        // — the gate's empty-input behavior is covered separately below.
        if (!ANNOUNCEMENT_VERSION || ANNOUNCEMENT_FEATURES.length === 0) {
            return;
        }

        markAnnouncementSeen(ANNOUNCEMENT_VERSION);
        expect(shouldShowAnnouncement()).toBe(false);
    });

    test("returns true when the live version was never marked", async () => {
        const mod = await import(`./announcement?t=${Date.now()}-none`);
        const { ANNOUNCEMENT_VERSION, ANNOUNCEMENT_FEATURES, shouldShowAnnouncement } = mod;

        if (!ANNOUNCEMENT_VERSION || ANNOUNCEMENT_FEATURES.length === 0) {
            // When empty, the gate is always false regardless of state
            expect(shouldShowAnnouncement()).toBe(false);
            return;
        }

        // No mark has been written in this fresh tmpRoot, so the gate is open
        expect(shouldShowAnnouncement()).toBe(true);
    });

    test("returns true when a different (older) version is marked", async () => {
        const mod = await import(`./announcement?t=${Date.now()}-older`);
        const {
            ANNOUNCEMENT_VERSION,
            ANNOUNCEMENT_FEATURES,
            markAnnouncementSeen,
            shouldShowAnnouncement,
        } = mod;

        if (!ANNOUNCEMENT_VERSION || ANNOUNCEMENT_FEATURES.length === 0) {
            return;
        }

        markAnnouncementSeen("0.0.0-pre-historic");
        expect(shouldShowAnnouncement()).toBe(true);
    });
});
