import { describe, expect, test } from "bun:test";
import { Database, withPrivilegedWriter } from "../../shared/sqlite";
import type { AuthorityModuleClient, AuthorityStatus } from "./context-authority";
import {
    ensureContextStoreUuid,
    getAuthorityManagedMarker,
    installAuthorityManagedMarker,
    reconcileAuthorityMarker,
    reconcileAuthorityProject,
} from "./context-authority";
import { insertMemory } from "./memory/storage-memory";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import { addNote } from "./storage-notes";
import { bumpProjectMemoryEpoch, getProjectState } from "./storage-project-state";

const PROJECT = "git:completed-authority-recovery";

function fixture(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    installAuthorityManagedMarker(db, PROJECT);
    return db;
}

function moduleWithStatus(status: AuthorityModuleClient["authorityStatus"]): AuthorityModuleClient {
    return {
        authorityStatus: status,
        authorityPrepare: async () => {
            throw new Error("reconciliation must not prepare authority");
        },
    };
}

function memoryWrite(db: Database): void {
    insertMemory(db, {
        projectPath: PROJECT,
        category: "CONSTRAINTS",
        content: "recovered memory",
        sourceSessionId: "recovery-fixture",
    });
}

function noteWrite(db: Database): void {
    addNote(db, "smart", {
        projectPath: PROJECT,
        content: "recovered note",
        surfaceCondition: "on next session",
    });
}

function expectWritesFenced(db: Database): void {
    expect(() => memoryWrite(db)).toThrow();
    expect(() => noteWrite(db)).toThrow();
}

describe("completed authority handoff recovery", () => {
    for (const shape of ["TS", "unowned", "mixed-unowned"] as const) {
        test(`releases a matching completed ${shape} handoff and permits memory and note writes`, async () => {
            const db = fixture();
            try {
                expectWritesFenced(db);
                const module = moduleWithStatus(async (args) => ({
                    authority:
                        shape === "unowned" ||
                        (shape === "mixed-unowned" && args.domain === "notes")
                            ? null
                            : { ...args, state: "TS", generation: 3 },
                }));
                await reconcileAuthorityProject({ db, projectPath: PROJECT, module });
                expect(getAuthorityManagedMarker(db, PROJECT)).toBeNull();
                expect(memoryWrite.bind(null, db)).not.toThrow();
                expect(noteWrite.bind(null, db)).not.toThrow();
                expect(
                    db.prepare("SELECT enabled FROM context_privilege_state WHERE id=1").get(),
                ).toEqual({ enabled: 0 });
                await reconcileAuthorityProject({ db, projectPath: PROJECT, module });
                expect(getAuthorityManagedMarker(db, PROJECT)).toBeNull();
            } finally {
                db.close();
            }
        });
    }

    for (const state of ["PREPARING", "MODULE", "DRAINING"] as const) {
        test(`keeps the shared marker when the notes domain remains ${state}`, async () => {
            const db = fixture();
            try {
                const before = getAuthorityManagedMarker(db, PROJECT);
                const module = moduleWithStatus(async (args) => ({
                    authority: {
                        ...args,
                        state: args.domain === "notes" ? state : "TS",
                        generation: 3,
                    },
                }));
                await reconcileAuthorityMarker({ db, projectPath: PROJECT, module });
                expect(getAuthorityManagedMarker(db, PROJECT)).toEqual(before);
                expectWritesFenced(db);
            } finally {
                db.close();
            }
        });
    }

    for (const mismatch of ["store", "project", "domain"] as const) {
        test(`does not trust a TS status for a different ${mismatch}`, async () => {
            const db = fixture();
            try {
                const before = getAuthorityManagedMarker(db, PROJECT);
                const module = moduleWithStatus(async (args) => {
                    const authority: AuthorityStatus = { ...args, state: "TS", generation: 3 };
                    if (args.domain === "memories") {
                        if (mismatch === "store") authority.context_store_uuid = "different-store";
                        if (mismatch === "project") authority.project = "different-project";
                        if (mismatch === "domain") authority.domain = "notes";
                    }
                    return { authority };
                });
                await reconcileAuthorityMarker({ db, projectPath: PROJECT, module });
                expect(getAuthorityManagedMarker(db, PROJECT)).toEqual(before);
                expectWritesFenced(db);
            } finally {
                db.close();
            }
        });
    }

    test("failed status leaves the original marker and ordinary writes fenced", async () => {
        const db = fixture();
        try {
            const before = getAuthorityManagedMarker(db, PROJECT);
            const module = moduleWithStatus(async (args) => {
                if (args.domain === "notes") throw new Error("status unavailable");
                return { authority: { ...args, state: "TS", generation: 3 } };
            });
            await expect(
                reconcileAuthorityMarker({ db, projectPath: PROJECT, module }),
            ).rejects.toThrow("status unavailable");
            expect(getAuthorityManagedMarker(db, PROJECT)).toEqual(before);
            expectWritesFenced(db);
        } finally {
            db.close();
        }
    });

    test("a marker from a different store is not removed by locally matching statuses", async () => {
        const db = fixture();
        try {
            const uuid = ensureContextStoreUuid(db);
            installAuthorityManagedMarker(db, PROJECT, "different-store");
            const module = moduleWithStatus(async (args) => ({
                authority: { ...args, context_store_uuid: uuid, state: "TS", generation: 3 },
            }));
            await reconcileAuthorityMarker({ db, projectPath: PROJECT, module });
            expect(getAuthorityManagedMarker(db, PROJECT)?.context_store_uuid).toBe(
                "different-store",
            );
            expectWritesFenced(db);
        } finally {
            db.close();
        }
    });

    test("a marker replaced during the status round trip is left intact", async () => {
        const db = fixture();
        try {
            const before = getAuthorityManagedMarker(db, PROJECT);
            if (!before) throw new Error("missing fixture marker");
            const module = moduleWithStatus(async (args) => {
                if (args.domain === "notes") {
                    withPrivilegedWriter(db, () =>
                        db
                            .prepare(
                                "UPDATE authority_managed SET marked_at=? WHERE project_path=?",
                            )
                            .run(before.marked_at + 1, PROJECT),
                    );
                }
                return { authority: { ...args, state: "TS", generation: 3 } };
            });
            await reconcileAuthorityMarker({ db, projectPath: PROJECT, module });
            expect(getAuthorityManagedMarker(db, PROJECT)?.marked_at).toBe(before.marked_at + 1);
            expectWritesFenced(db);
        } finally {
            db.close();
        }
    });
});

test("marker release and memory invalidation roll back together", async () => {
    const db = fixture();
    const before = getAuthorityManagedMarker(db, PROJECT);
    const module = moduleWithStatus(async (args) => ({
        authority: { ...args, state: "TS", generation: 3 },
    }));
    try {
        await expect(
            reconcileAuthorityMarker({
                db,
                projectPath: PROJECT,
                module,
                onMarkerReleased: () => {
                    bumpProjectMemoryEpoch(db, PROJECT);
                    throw new Error("invalidation failed");
                },
            }),
        ).rejects.toThrow("invalidation failed");
        expect(getAuthorityManagedMarker(db, PROJECT)).toEqual(before);
        expect(getProjectState(db, PROJECT)?.projectMemoryEpoch ?? 0).toBe(0);
        expectWritesFenced(db);
        expect(db.prepare("SELECT enabled FROM context_privilege_state WHERE id=1").get()).toEqual({
            enabled: 0,
        });
    } finally {
        db.close();
    }
});
