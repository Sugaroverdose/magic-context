import {
    historianOrphanStaleMs,
    retrospectiveOrphanStaleMs,
} from "../features/magic-context/dreamer/retrospective-orphan-sweep";
import type { HiddenRunIdentity } from "../hooks/magic-context/compartment-runner-types";
import { declareHostLimitation } from "../shared/host-limitations";
import { log } from "../shared/logger";
import type { Database } from "../shared/sqlite";
import type { V2HiddenCompletionOptions } from "./hidden-completion";
import {
    assistantOutcome,
    childCreateInput,
    errorText,
    type HiddenChildHost,
    type HiddenChildLifecycle,
    type HiddenChildModel,
    type HiddenChildRole,
    keptUnderRetention,
    type PersistedHiddenChild,
    roleTitle,
    withReader,
} from "./hidden-child-record";
import { hiddenToolLoop } from "./hooks/hidden-child";
import { type HostServiceOwner, HostServiceUnavailable, hostServiceOwner } from "./host-service";
import type { StoreRow } from "./store-reader";

/**
 * The hidden-child lifecycle for OpenCode 2 hosts whose plugin session API cannot remove sessions
 * (every release up to 2.0.21). Such a host cannot parent a plugin-created session either, so each
 * child is a root session the user can see. To keep their number down, one child per role is
 * reused across runs and recorded in context.db; a retired child is deleted through the HTTP route
 * of the host service that created it, retried at every boot, and otherwise left for
 * `doctor --fix`.
 *
 * Everything here exists only for those hosts. Once Magic Context requires an OpenCode 2 release
 * whose plugin API has `session.remove`, this module, its branch in
 * `createV2HiddenCompletionExecutor`, and the `doctor --fix` hidden-child cleanup can be deleted.
 */

interface RetiredHiddenChild extends PersistedHiddenChild {
    retired_at: number;
    reason: string;
}

/** The parts of a retired child that deleting its session needs. */
type RetirableChild = Pick<PersistedHiddenChild, "id" | "owner" | "directory">;

interface HiddenChildrenMeta {
    version: 1;
    active: Partial<Record<HiddenChildRole, PersistedHiddenChild>>;
    retired_children: RetiredHiddenChild[];
}

const META_PREFIX = "opencode2_hidden_children:";
const REMOVAL_SPACING_MS = 250;
/**
 * Ceiling on remembered retired children. Entries leave this list as their sessions are deleted, so
 * it only grows while deletion is failing or unavailable; the cap keeps a long outage from growing
 * the project's metadata row without limit. The oldest entries are dropped first because the sweep
 * drains oldest first, so anything still at the front after a full pass is what deletion keeps
 * refusing; those sessions are then left behind in the host rather than retried forever. Children
 * kept under `keep_subagents` also stay listed (so every boot still recognises them as hidden
 * children) and count toward the same cap; evicting one only forgets it, its session stays.
 */
const RETIRED_CHILDREN_LIMIT = 200;
const LEGACY_CLEANUP_BOOT_LIMIT = 5;

export function hiddenChildrenMetaKey(projectIdentity: string, directory?: string): string {
    return directory === undefined
        ? `${META_PREFIX}${projectIdentity}`
        : `${META_PREFIX}${JSON.stringify([projectIdentity, directory])}`;
}

function emptyMeta(): HiddenChildrenMeta {
    return { version: 1, active: {}, retired_children: [] };
}

function isModel(value: unknown): value is HiddenChildModel {
    if (!value || typeof value !== "object") return false;
    const model = value as Partial<HiddenChildModel>;
    return typeof model.providerID === "string" && typeof model.modelID === "string";
}

function isRole(value: unknown): value is HiddenChildRole {
    return value === "historian" || value === "dreamer" || value === "dreamer-curate";
}

function isOwner(value: unknown): value is HostServiceOwner {
    if (!value || typeof value !== "object") return false;
    const owner = value as Partial<HostServiceOwner>;
    return (
        typeof owner.registration === "string" &&
        owner.registration.length > 0 &&
        typeof owner.pid === "number" &&
        (owner.serviceID === undefined || typeof owner.serviceID === "string")
    );
}

function isPersistedChild(value: unknown): value is PersistedHiddenChild {
    if (!value || typeof value !== "object") return false;
    const child = value as Partial<PersistedHiddenChild>;
    return (
        typeof child.id === "string" &&
        isRole(child.role) &&
        typeof child.generation === "string" &&
        typeof child.title === "string" &&
        isModel(child.model) &&
        typeof child.created_at === "number" &&
        typeof child.title_reasserted === "boolean" &&
        (child.ever_settled === undefined || typeof child.ever_settled === "boolean") &&
        (child.owner === undefined || isOwner(child.owner)) &&
        (child.directory === undefined || typeof child.directory === "string") &&
        (child.cleanup_attempts === undefined ||
            (Number.isInteger(child.cleanup_attempts) && child.cleanup_attempts >= 0))
    );
}

function parseMeta(value: string | null): HiddenChildrenMeta {
    if (value === null) return emptyMeta();
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch (error) {
        throw new Error("Invalid OpenCode 2 hidden-child metadata JSON", { cause: error });
    }
    if (!parsed || typeof parsed !== "object") {
        throw new Error("Invalid OpenCode 2 hidden-child metadata");
    }
    const candidate = parsed as Partial<HiddenChildrenMeta>;
    if (candidate.version !== 1 || !candidate.active || !candidate.retired_children) {
        throw new Error("Unsupported OpenCode 2 hidden-child metadata version");
    }
    const active: HiddenChildrenMeta["active"] = {};
    for (const role of ["historian", "dreamer"] as const) {
        const child = candidate.active[role];
        if (child !== undefined) {
            if (!isPersistedChild(child) || child.role !== role) {
                throw new Error(`Invalid OpenCode 2 ${role} child metadata`);
            }
            active[role] = child;
        }
    }
    const retired = candidate.retired_children;
    if (
        !Array.isArray(retired) ||
        retired.some(
            (child) =>
                !isPersistedChild(child) ||
                typeof (child as Partial<RetiredHiddenChild>).retired_at !== "number" ||
                typeof (child as Partial<RetiredHiddenChild>).reason !== "string",
        )
    ) {
        throw new Error("Invalid OpenCode 2 retired-child metadata");
    }
    return { version: 1, active, retired_children: retired as RetiredHiddenChild[] };
}

class HiddenChildStateStore {
    private readonly key: string;

    constructor(
        private readonly db: Database,
        projectIdentity: string,
        directory: string,
    ) {
        this.key = hiddenChildrenMetaKey(projectIdentity, directory);
        this.legacyKey = hiddenChildrenMetaKey(projectIdentity);
    }

    private readonly legacyKey: string;

    migrateStale(isStale: (child: PersistedHiddenChild) => boolean): void {
        this.db
            .transaction(() => {
                const legacyRow = this.db
                    .prepare("SELECT value FROM schema_migrations_meta WHERE key = ?")
                    .get(this.legacyKey) as { value: string } | undefined;
                if (!legacyRow) return;
                const legacy = parseMeta(legacyRow.value);
                const scoped = this.read();
                for (const role of ["historian", "dreamer"] as const) {
                    const child = legacy.active[role];
                    if (!child || !isStale(child)) continue;
                    scoped.retired_children.push({
                        ...child,
                        retired_at: Date.now(),
                        reason: "legacy-directory-scope",
                    });
                    delete legacy.active[role];
                }
                const remaining: RetiredHiddenChild[] = [];
                for (const child of legacy.retired_children) {
                    if (isStale(child)) scoped.retired_children.push(child);
                    else remaining.push(child);
                }
                legacy.retired_children = remaining;
                const excess = scoped.retired_children.length - RETIRED_CHILDREN_LIMIT;
                if (excess > 0) scoped.retired_children.splice(0, excess);
                this.db
                    .prepare(`INSERT INTO schema_migrations_meta (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
                    .run(this.key, JSON.stringify(scoped));
                if (
                    Object.keys(legacy.active).length === 0 &&
                    legacy.retired_children.length === 0
                ) {
                    this.db
                        .prepare("DELETE FROM schema_migrations_meta WHERE key = ?")
                        .run(this.legacyKey);
                } else {
                    this.db
                        .prepare("UPDATE schema_migrations_meta SET value = ? WHERE key = ?")
                        .run(JSON.stringify(legacy), this.legacyKey);
                }
            })
            .immediate();
    }

    read(): HiddenChildrenMeta {
        const row = this.db
            .prepare("SELECT value FROM schema_migrations_meta WHERE key = ?")
            .get(this.key) as { value: string } | undefined;
        return parseMeta(row?.value ?? null);
    }

    mutate<T>(change: (state: HiddenChildrenMeta) => T): T {
        return this.db
            .transaction(() => {
                const state = this.read();
                const result = change(state);
                this.db
                    .prepare(
                        `INSERT INTO schema_migrations_meta (key, value) VALUES (?, ?)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
                    )
                    .run(this.key, JSON.stringify(state));
                return result;
            })
            .immediate();
    }

    put(child: PersistedHiddenChild): void {
        this.mutate((state) => {
            state.active[child.role] = child;
        });
    }

    updateModel(child: PersistedHiddenChild, model: HiddenChildModel): PersistedHiddenChild {
        return this.mutate((state) => {
            const active = state.active[child.role];
            if (!active || active.id !== child.id) return { ...child, model };
            active.model = model;
            return { ...active };
        });
    }

    markTitleReasserted(child: PersistedHiddenChild): PersistedHiddenChild {
        return this.mutate((state) => {
            const active = state.active[child.role];
            if (!active || active.id !== child.id) return { ...child, title_reasserted: true };
            active.title_reasserted = true;
            return { ...active };
        });
    }

    markEverSettled(child: PersistedHiddenChild): PersistedHiddenChild {
        return this.mutate((state) => {
            const active = state.active[child.role];
            if (!active || active.id !== child.id) return { ...child, ever_settled: true };
            active.ever_settled = true;
            return { ...active };
        });
    }

    retire(child: PersistedHiddenChild, reason: string): void {
        this.mutate((state) => {
            const active = state.active[child.role];
            if (!active || active.id !== child.id) return;
            state.retired_children.push({
                ...active,
                retired_at: Date.now(),
                reason,
            });
            const excess = state.retired_children.length - RETIRED_CHILDREN_LIMIT;
            if (excess > 0) state.retired_children.splice(0, excess);
            delete state.active[child.role];
        });
    }

    recordLegacyFailure(id: string): number {
        return this.mutate((state) => {
            const child = state.retired_children.find((entry) => entry.id === id);
            if (!child) return 0;
            child.cleanup_attempts = (child.cleanup_attempts ?? 0) + 1;
            return child.cleanup_attempts;
        });
    }

    /** Forgets one retired child, called once its session is gone from the host. */
    prune(id: string): void {
        this.mutate((state) => {
            state.retired_children = state.retired_children.filter((child) => child.id !== id);
        });
    }
}

function successfulReusableAssistant(row: StoreRow<"assistant"> | undefined): boolean {
    return (
        row !== undefined &&
        (typeof row.data.finish === "string" || assistantOutcome(row) === "succeeded") &&
        row.data.error === undefined &&
        row.data.tokens !== undefined
    );
}

/**
 * Boots the legacy lifecycle: migrates bookkeeping written before children were keyed per
 * directory, re-registers recorded children with the hidden-child hook, and queues the boot sweep
 * of retired children.
 */
export async function createLegacyHiddenChildren(
    host: HiddenChildHost,
    options: V2HiddenCompletionOptions,
    generation: string,
): Promise<HiddenChildLifecycle> {
    const store = new HiddenChildStateStore(options.db, options.projectIdentity, options.directory);

    const legacy = options.db
        .prepare("SELECT value FROM schema_migrations_meta WHERE key = ?")
        .get(hiddenChildrenMetaKey(options.projectIdentity)) as { value: string } | undefined;
    if (legacy) {
        const children = parseMeta(legacy.value);
        const statuses = new Map<string, Record<string, { type: string }> | undefined>();
        for (const child of [...Object.values(children.active), ...children.retired_children]) {
            if (!child || !host.status) continue;
            const directory = child.directory ?? options.directory;
            if (!statuses.has(directory)) {
                try {
                    statuses.set(directory, await host.status({ directory }));
                } catch {
                    statuses.set(directory, undefined);
                }
            }
        }
        store.migrateStale((child) => {
            const directory = child.directory ?? options.directory;
            const state = statuses.get(directory);
            if (
                host.status &&
                (!state || state[child.id]?.type === "busy" || state[child.id]?.type === "retry")
            )
                return false;
            const last = Math.max(
                child.created_at,
                withReader(options.openReader, (reader) =>
                    Math.max(
                        reader.latestAssistant(child.id)?.data.time?.created ?? 0,
                        reader.latestIdle(child.id)?.data.time?.created ?? 0,
                    ),
                ),
            );
            const staleMs =
                child.role === "historian"
                    ? historianOrphanStaleMs(20 * 60_000, 3)
                    : retrospectiveOrphanStaleMs(undefined);
            return Date.now() - last > staleMs;
        });
    }
    const persisted = store.read();
    for (const child of [...Object.values(persisted.active), ...persisted.retired_children]) {
        if (child) options.hook.registerChild(child.id);
    }

    const spacing = options.removalSpacingMs ?? REMOVAL_SPACING_MS;
    const resolveOwner = options.resolveOwner ?? hostServiceOwner;
    const note = options.log ?? log;
    const queued = new Set<string>();
    // One chain, so removals never overlap however many retirements land at once.
    let removals: Promise<void> = Promise.resolve();

    const pause = (ms: number) =>
        new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, ms);
            // Draining leftovers must never be the reason a host process stays alive.
            (timer as unknown as { unref?: () => void }).unref?.();
        });

    const noteUnbound = () => {
        if (declareHostLimitation("hidden_cleanup_unbound")) {
            note(
                `[magic-context] ${store.read().retired_children.length} retired hidden children cannot be deleted: no owner-bound host removal route; run \`doctor --fix\` with OpenCode closed`,
            );
        }
    };

    const removeChildSession = async (child: RetirableChild, fromBoot: boolean): Promise<void> => {
        const remove = host.remove;
        if (!remove) {
            noteUnbound();
            return;
        }
        try {
            await remove({
                sessionID: child.id,
                ...(child.owner === undefined ? {} : { owner: child.owner }),
                ...(child.directory === undefined ? {} : { directory: child.directory }),
            });
        } catch (error) {
            // The host was unreachable, refused, or is not the one that created this child. Keep
            // the entry so a later sweep retries it; cleanup is never allowed to fail the hidden
            // run that triggered it.
            if (error instanceof HostServiceUnavailable) {
                // A server without host service registration cannot delete any retired child.
                // Report the backlog and offline remedy once instead of logging each child.
                noteUnbound();
                return;
            }
            if (fromBoot && child.directory === undefined) {
                const attempts = store.recordLegacyFailure(child.id);
                if (attempts >= LEGACY_CLEANUP_BOOT_LIMIT) {
                    store.prune(child.id);
                    note(
                        `[magic-context] legacy hidden child ${child.id} dropped after ${attempts} failed boot cleanup attempts: ${errorText(error)}`,
                    );
                    return;
                }
            }
            note(
                `[magic-context] hidden child ${child.id} could not be deleted, left for a later sweep: ${errorText(error)}`,
            );
            return;
        }
        try {
            store.prune(child.id);
        } catch (error) {
            note(
                `[magic-context] hidden child ${child.id} was deleted but not forgotten: ${errorText(error)}`,
            );
        }
    };

    /**
     * Queues a retired child's session for deletion. Returns immediately: a caller in the middle of
     * a hidden run must not wait on host cleanup.
     */
    const scheduleRemoval = (child: RetirableChild, fromBoot = false): void => {
        if (queued.has(child.id)) return;
        queued.add(child.id);
        removals = removals
            .then(() => pause(spacing))
            .then(() => removeChildSession(child, fromBoot))
            .catch((error) => {
                note(
                    `[magic-context] hidden child ${child.id} removal queue failed: ${errorText(error)}`,
                );
            })
            .finally(() => {
                queued.delete(child.id);
            });
    };

    const keepSubagents = options.keepSubagents === true;

    const retireChild = (child: PersistedHiddenChild, reason: string): void => {
        store.retire(child, reason);
        if (!keptUnderRetention(keepSubagents, child)) scheduleRemoval(child);
    };

    const createChild = async (
        identity: HiddenRunIdentity,
        role: HiddenChildRole,
        model: HiddenChildModel,
    ): Promise<PersistedHiddenChild> => {
        const title = roleTitle(role);
        const created = await host.create(childCreateInput(identity, role, model));
        if (!created.id) throw new Error("OpenCode 2 did not return a child session id");
        const owner = resolveOwner();
        const child: PersistedHiddenChild = {
            id: created.id,
            role,
            generation,
            title,
            model,
            created_at: Date.now(),
            title_reasserted: false,
            directory: identity.directory,
            ...(owner === undefined ? {} : { owner }),
        };
        store.put(child);
        options.hook.registerChild(child.id);
        return child;
    };

    // Boot sweep. Anything left over from an earlier process — including the backlog built up
    // before retirement deleted anything — is drained here, spaced like every other removal.
    // Children the current setting keeps are skipped; turning `keep_subagents` off later lets the
    // next boot delete them, as the OpenCode 1 sweep does.
    for (const child of persisted.retired_children) {
        if (!keptUnderRetention(keepSubagents, child)) scheduleRemoval(child, true);
    }

    return {
        async open(identity, role, model) {
            let active = store.read().active[role];
            if (active && hiddenToolLoop(identity)) {
                retireChild(active, "fresh-tool-loop-run");
                active = undefined;
            }
            if (active && active.generation !== generation) {
                retireChild(active, "host-generation-changed");
                active = undefined;
            }
            if (active) {
                const activeID = active.id;
                const latest = withReader(options.openReader, (reader) => ({
                    assistant: reader.latestAssistant(activeID),
                    idle: reader.latestIdle(activeID),
                }));
                const idleIsNewest =
                    latest.idle !== undefined &&
                    (latest.assistant === undefined || latest.idle.seq > latest.assistant.seq);
                const idleOutcome = idleIsNewest ? latest.idle?.data.outcome : undefined;
                const reusable =
                    (idleOutcome === undefined || idleOutcome === "succeeded") &&
                    successfulReusableAssistant(latest.assistant);
                if (!reusable) {
                    retireChild(active, "newest-assistant-not-reusable");
                    active = undefined;
                }
            }
            // Bind a new child to the host that is creating it, now, while that host is
            // demonstrably this process. Deleting it later goes through this binding and nothing
            // else.
            return active ?? createChild(identity, role, model);
        },
        create: createChild,
        retire: retireChild,
        // A child whose run ended without retirement stays recorded for the next run to reuse.
        finish: async () => {},
        updateModel: (child, model) => store.updateModel(child, model),
        markTitleReasserted: (child) => store.markTitleReasserted(child),
        markEverSettled: (child) => store.markEverSettled(child),
    };
}
