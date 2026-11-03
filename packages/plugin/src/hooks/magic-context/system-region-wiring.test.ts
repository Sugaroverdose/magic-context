/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { insertMemory } from "../../features/magic-context/memory/storage-memory";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    hasCompleteCachedM0M1,
    injectM0M1,
    type M0M1State,
    mustMaterialize,
    prepareCachedM0M1Replay,
} from "./inject-compartments";
import { readSystemRegion, SYSTEM_REGION_SENTINEL, writeSystemRegion } from "./system-region";
import type { MessageLike } from "./tag-messages";

const SESSION_ID = "ses_region_wiring";
const PROJECT_PATH = "/tmp/test-region-wiring";

function makeDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    getOrCreateSessionMeta(db, SESSION_ID);
    insertMemory(db, {
        projectPath: PROJECT_PATH,
        category: "ARCHITECTURE",
        content: "wiring law memory",
    });
    return db;
}

function row(db: Database) {
    return db
        .prepare("SELECT cached_m0_bytes, cached_m1_bytes FROM session_meta WHERE session_id = ?")
        .get(SESSION_ID) as {
        cached_m0_bytes: Uint8Array | null;
        cached_m1_bytes: Uint8Array | null;
    };
}

function freshState(db: Database): M0M1State {
    const meta = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
    return meta;
}

function foldOptions(db: Database, messages: MessageLike[], regionEnabled: boolean) {
    return {
        db,
        sessionId: SESSION_ID,
        state: freshState(db),
        projectPath: PROJECT_PATH,
        projectDirectory: "",
        messages,
        isCacheBustingPass: true,
        systemRegion: regionEnabled ? { enabled: true, reason: "hard_fold" } : undefined,
    } as never;
}

describe("system-region wiring: gate on collapses the head lane", () => {
    it("first fold installs the region and prepends zero head messages", () => {
        const db = makeDb();
        const messages: MessageLike[] = [
            { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "hi" }] },
        ];
        const result = injectM0M1(foldOptions(db, messages, true));
        expect(result.prependedMessageCount).toBe(0);
        expect(messages.length).toBe(1);
        expect(messages[0].info.id).toBe("u1");
        const stored = row(db);
        expect(
            Buffer.from(stored.cached_m0_bytes!)
                .toString("utf8")
                .startsWith(SYSTEM_REGION_SENTINEL),
        ).toBe(true);
        expect(stored.cached_m1_bytes).toBeNull();
        expect(readSystemRegion(db, SESSION_ID)).toContain("wiring law memory");
    });

    it("second gated pass replays: no fold, no head, m1 stays null, no new region bytes", () => {
        const db = makeDb();
        injectM0M1(foldOptions(db, [], true));
        const before = row(db);
        const messages: MessageLike[] = [
            { info: { id: "u2", role: "user" }, parts: [{ type: "text", text: "next" }] },
        ];
        const result = injectM0M1(foldOptions(db, messages, true));
        expect(result.prependedMessageCount).toBe(0);
        expect(result.m0RematerializedThisPass).toBe(false);
        expect(messages.length).toBe(1);
        const after = row(db);
        expect(Buffer.from(after.cached_m0_bytes!)).toEqual(Buffer.from(before.cached_m0_bytes!));
        expect(after.cached_m1_bytes).toBeNull();
    });

    it("gate off control: the head lane still prepends its two synthetic messages", () => {
        const db = makeDb();
        const messages: MessageLike[] = [
            { info: { id: "u3", role: "user" }, parts: [{ type: "text", text: "hi" }] },
        ];
        const result = injectM0M1(foldOptions(db, messages, false));
        expect(result.prependedMessageCount).toBe(2);
        expect(messages.length).toBe(3);
        expect(messages[0].info.role).toBe("user");
        expect((messages[0].info as { syntheticHead?: boolean }).syntheticHead).toBe(true);
        expect(Buffer.from(row(db).cached_m0_bytes!).toString("utf8")).not.toContain(
            SYSTEM_REGION_SENTINEL,
        );
    });
});

describe("system-region wiring: mustMaterialize arms in region mode", () => {
    it("a legacy raw row demands the region_first_install fold", () => {
        const db = makeDb();
        db.prepare(
            "UPDATE session_meta SET cached_m0_bytes = ?, cached_m1_bytes = ? WHERE session_id = ?",
        ).run(
            Buffer.from("<session-history>legacy</session-history>", "utf8"),
            Buffer.from("<m1/>", "utf8"),
            SESSION_ID,
        );
        const state = freshState(db);
        const decision = mustMaterialize({
            db,
            sessionId: SESSION_ID,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory: "",
            systemRegionMode: true,
        } as never);
        expect(decision.value).toBe(true);
        expect(decision.reason).toBe("region_first_install");
    });

    it("a valid region row with a null m1 never re-triggers cached_m1_missing", () => {
        const db = makeDb();
        writeSystemRegion(db, SESSION_ID, "<project-memory>frozen</project-memory>");
        const state = freshState(db);
        state.cachedM1Bytes = null;
        const decision = mustMaterialize({
            db,
            sessionId: SESSION_ID,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory: "",
            systemRegionMode: true,
        } as never);
        expect(decision.reason).not.toBe("cached_m1_missing");
    });

    it("without region mode the m1-missing arm keeps its bite (control)", () => {
        const db = makeDb();
        db.prepare(
            "UPDATE session_meta SET cached_m0_bytes = ?, cached_m1_bytes = NULL WHERE session_id = ?",
        ).run(Buffer.from("<session-history>head</session-history>", "utf8"), SESSION_ID);
        const state = freshState(db);
        state.cachedM1Bytes = null;
        const decision = mustMaterialize({
            db,
            sessionId: SESSION_ID,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory: "",
        });
        expect(decision.value).toBe(true);
        expect(decision.reason).toBe("cached_m1_missing");
    });
});

describe("system-region wiring: replay plumbing is sentinel-aware", () => {
    it("a sentinel row counts as a complete cached prefix and replays without heads", () => {
        const db = makeDb();
        writeSystemRegion(db, SESSION_ID, "<project-memory>frozen</project-memory>");
        expect(hasCompleteCachedM0M1(db, SESSION_ID)).toBe(true);
        const replay = prepareCachedM0M1Replay(db, SESSION_ID);
        expect(replay).toBeDefined();
        expect(replay!.preparedMessages.length).toBe(0);
    });

    it("control: a raw m0 row with null m1 is not complete", () => {
        const db = makeDb();
        db.prepare(
            "UPDATE session_meta SET cached_m0_bytes = ?, cached_m1_bytes = NULL WHERE session_id = ?",
        ).run(Buffer.from("<session-history>head</session-history>", "utf8"), SESSION_ID);
        expect(hasCompleteCachedM0M1(db, SESSION_ID)).toBe(false);
        expect(prepareCachedM0M1Replay(db, SESSION_ID)).toBeUndefined();
    });
});
