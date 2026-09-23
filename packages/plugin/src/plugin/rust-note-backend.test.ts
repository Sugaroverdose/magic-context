import { beforeEach, describe, expect, it } from "bun:test";

import { runMigrations } from "../features/magic-context/migrations";
import { initializeDatabase } from "../features/magic-context/storage-db";
import { Database } from "../shared/sqlite";
import { createCtxNoteTools } from "../tools/ctx-note/tools";
import { createRustNoteBackend, type RustNoteModuleCaller } from "./rust-note-backend";

const PROJECT = "git:project-a";
const FOREIGN_PROJECT = "git:project-b";
const SESSION = "ses-note";

/**
 * The shape that broke a live session: the agent is shown host note #652, whose
 * module row is #1104, while a DIFFERENT module row happens to have id 652 and
 * mirrors to host #1870.
 */
const HOST_ID = 652;
const MODULE_ID = 1104;
const COLLIDING_HOST_ID = 1870;

function freshDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function insertHostNote(
    db: Database,
    args: { id: number; project: string; session: string; content: string; type?: string },
): void {
    db.prepare(
        `INSERT INTO notes (id, type, status, content, session_id, project_path, created_at, updated_at)
         VALUES (?, ?, 'ready', ?, ?, ?, 1, 1)`,
    ).run(args.id, args.type ?? "smart", args.content, args.session, args.project);
}

function mirror(db: Database, project: string, moduleRowId: number, contextRowId: number): void {
    db.prepare(
        "INSERT INTO mirror_identity(domain, module_project, module_row_id, context_row_id) VALUES ('notes', ?, ?, ?)",
    ).run(project, moduleRowId, contextRowId);
}

/**
 * Which module rows a recorded ctx_note call addresses. A request on the host id
 * lane names host ids plus the host→module pairs to resolve them; any other
 * request names module rows directly.
 */
function addressedModuleIds(args: Record<string, unknown>): Array<number | null> {
    const noteIds = (args.note_ids as number[] | undefined) ?? [];
    if (args.note_id_lane !== "host") return noteIds;
    const pairs = new Map(
        ((args.note_id_map as Array<[number, number]> | undefined) ?? []).map(
            ([hostId, moduleId]) => [hostId, moduleId] as const,
        ),
    );
    return noteIds.map((hostId) => pairs.get(hostId) ?? null);
}

describe("ctx_note ids under module note authority", () => {
    let db: Database;
    let calls: Array<Record<string, unknown>>;

    function tools() {
        const module: RustNoteModuleCaller = {
            call: async ({ body }) => {
                calls.push(body.arguments);
                return { content: [{ type: "text", text: "module reply" }] };
            },
        };
        return createCtxNoteTools({
            db,
            dreamerEnabled: true,
            resolveProjectPath: () => PROJECT,
            rustToolBackends: {
                authorityState: async () => "MODULE",
                noteEvaluationAvailable: () => true,
                note: createRustNoteBackend({ db, module, syncNotes: async () => {} }),
            },
        }).ctx_note;
    }

    const context = { sessionID: SESSION, directory: "/workspace/project-a" } as never;

    beforeEach(() => {
        db = freshDb();
        calls = [];
        insertHostNote(db, {
            id: HOST_ID,
            project: PROJECT,
            session: SESSION,
            content: "the note the reminder announced",
        });
        mirror(db, PROJECT, MODULE_ID, HOST_ID);
    });

    for (const collision of ["foreign-project", "same-project"] as const) {
        describe(`with a ${collision} module row sitting at the host id`, () => {
            beforeEach(() => {
                const project = collision === "foreign-project" ? FOREIGN_PROJECT : PROJECT;
                insertHostNote(db, {
                    id: COLLIDING_HOST_ID,
                    project,
                    session: collision === "foreign-project" ? "ses-other" : SESSION,
                    content: "an unrelated note that must never be touched",
                    type: "session",
                });
                mirror(db, project, HOST_ID, COLLIDING_HOST_ID);
            });

            it.failing("read by the host id asks the module for the announced note", async () => {
                await tools().execute({ action: "read", note_ids: [HOST_ID] }, context);
                expect(calls).toHaveLength(1);
                expect(addressedModuleIds(calls[0])).toEqual([MODULE_ID]);
            });

            it.failing("dismiss by the host id never addresses the colliding module row", async () => {
                await tools().execute({ action: "dismiss", note_ids: [HOST_ID] }, context);
                expect(calls).toHaveLength(1);
                expect(addressedModuleIds(calls[0])).toEqual([MODULE_ID]);
                expect(addressedModuleIds(calls[0])).not.toContain(HOST_ID);
            });

            it.failing("an update's compile metadata lands on the announced note", async () => {
                await tools().execute(
                    {
                        action: "update",
                        note_ids: [HOST_ID],
                        surface_condition: "when path /tmp/project-binding-key exists",
                    },
                    context,
                );
                expect(
                    db
                        .prepare(
                            "SELECT id, compile_status FROM notes WHERE id IN (?, ?) ORDER BY id",
                        )
                        .all(HOST_ID, COLLIDING_HOST_ID),
                ).toEqual([
                    { id: HOST_ID, compile_status: "refused" },
                    { id: COLLIDING_HOST_ID, compile_status: null },
                ]);
            });
        });
    }
});
