import type {
    HiddenCompletion,
    HiddenCompletionExecutor,
    HiddenRunHandle,
    HiddenRunIdentity,
} from "../hooks/magic-context/compartment-runner-types";
import { HiddenCompletionRefusal } from "../hooks/magic-context/compartment-runner-types";
import { estimateTokens } from "../hooks/magic-context/read-session-formatting";
import { declareHostLimitation } from "../shared/host-limitations";
import { log } from "../shared/logger";
import type { PromptArgs } from "../shared/model-suggestion-retry";
import { parseProviderModel, toModelEntry } from "../shared/resolve-fallbacks";
import type { Database } from "../shared/sqlite";
import {
    HIDDEN_DREAMER_AGENT,
    HIDDEN_HISTORIAN_AGENT,
    type HiddenChildAttempt,
    type HiddenChildHook,
} from "./hooks/hidden-child";
import { type HostServiceOwner, HostServiceUnavailable, hostServiceOwner } from "./host-service";
import type { StoreRow } from "./store-reader";

interface Model {
    providerID: string;
    modelID: string;
    variant?: string;
}

type AssistantOutcome = "succeeded" | "failed" | "interrupted";

type HiddenChildRole = "historian" | "dreamer";

interface PersistedHiddenChild {
    id: string;
    role: HiddenChildRole;
    generation: string;
    title: string;
    model: Model;
    created_at: number;
    title_reasserted: boolean;
    /**
     * The host service registration that owned this child when it was created, or absent when the
     * creating host had registered none (and for rows written before this was recorded). Deletion
     * goes through this and nothing else, so an absent binding means the child's session can only
     * be left behind and reported.
     */
    owner?: HostServiceOwner;
}

interface RetiredHiddenChild extends PersistedHiddenChild {
    retired_at: number;
    reason: string;
}

/** The parts of a retired child that deleting its session needs. */
type RetirableChild = Pick<PersistedHiddenChild, "id" | "owner">;

interface HiddenChildrenMeta {
    version: 1;
    active: Partial<Record<HiddenChildRole, PersistedHiddenChild>>;
    retired_children: RetiredHiddenChild[];
}

export interface HiddenChildHost {
    create(input: {
        title: string;
        agent: string;
        model: { providerID: string; id: string; variant?: string };
        location: { directory: string };
        metadata: { magic_context: "hidden-run"; role: HiddenChildRole };
    }): Promise<{ id: string }>;
    get(input: { sessionID: string }): Promise<{
        model?: { providerID: string; id: string; variant?: string };
        /** Returned only when the host exposes an error for the terminal session. */
        error?: unknown;
    }>;
    switchModel(input: {
        sessionID: string;
        model: { providerID: string; id: string; variant?: string };
    }): Promise<void>;
    prompt(input: { sessionID: string; text: string }): Promise<unknown>;
    wait(input: { sessionID: string }): Promise<void>;
    interrupt(input: { sessionID: string }): Promise<{ interrupted: boolean }>;
    update(input: { sessionID: string; title: string }): Promise<void>;
    /**
     * Deletes a session and everything hanging off it, through the host that created it. Optional
     * because the host surface this adapter is handed does not always carry it; when it is missing,
     * a retired child keeps its entry in the retired list and the next boot sweep tries again.
     */
    remove?(input: { sessionID: string; owner?: HostServiceOwner }): Promise<void>;
}

export interface HiddenChildRows {
    latestSequence(sessionID: string): number;
    latestAssistant(sessionID: string): StoreRow<"assistant"> | undefined;
    latestIdle(sessionID: string): StoreRow<"idle"> | undefined;
}

export interface V2HiddenCompletionOptions {
    db: Database;
    projectIdentity: string;
    hook: HiddenChildHook;
    openReader: () => HiddenChildRows & { close?: () => void };
    ensureAgent?(): Promise<void>;
    generation?: string;
    /**
     * Gap left between two session removals. Deleting a session walks its children one at a time
     * inside the host and publishes an event per deletion, so a backlog is drained slowly on
     * purpose rather than fired off in parallel.
     */
    removalSpacingMs?: number;
    /**
     * Which host service registration, if any, owns the children this process creates. Called once
     * per created child so a host that starts serving later still binds correctly.
     */
    resolveOwner?: () => HostServiceOwner | undefined;
    log?: (message: string) => void;
}

interface RunState {
    identity: HiddenRunIdentity;
    role: HiddenChildRole;
    child: PersistedHiddenChild;
    releaseRole: () => void;
    completion?: HiddenCompletion;
    failed: boolean;
    /** A failure other than a settled provider error row (dispatch error, refusal, timeout, abort). */
    unsettledFailure: boolean;
    retired: boolean;
}

const META_PREFIX = "opencode2_hidden_children:";
const POLL_INTERVAL_MS = 200;
const REMOVAL_SPACING_MS = 250;
/**
 * Ceiling on remembered retired children. Entries leave this list as their sessions are deleted, so
 * it only grows while deletion is failing or unavailable; the cap keeps a long outage from growing
 * the project's metadata row without limit. The oldest entries are dropped first because the sweep
 * drains oldest first, so anything still at the front after a full pass is what deletion keeps
 * refusing; those sessions are then left behind in the host rather than retried forever.
 */
const RETIRED_CHILDREN_LIMIT = 200;

export function hiddenChildrenMetaKey(projectIdentity: string): string {
    return `${META_PREFIX}${projectIdentity}`;
}

function emptyMeta(): HiddenChildrenMeta {
    return { version: 1, active: {}, retired_children: [] };
}

function isModel(value: unknown): value is Model {
    if (!value || typeof value !== "object") return false;
    const model = value as Partial<Model>;
    return typeof model.providerID === "string" && typeof model.modelID === "string";
}

function isRole(value: unknown): value is HiddenChildRole {
    return value === "historian" || value === "dreamer";
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
        (child.owner === undefined || isOwner(child.owner))
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
    ) {
        this.key = hiddenChildrenMetaKey(projectIdentity);
    }

    read(): HiddenChildrenMeta {
        const row = this.db
            .prepare("SELECT value FROM schema_migrations_meta WHERE key = ?")
            .get(this.key) as { value: string } | undefined;
        return parseMeta(row?.value ?? null);
    }

    mutate<T>(change: (state: HiddenChildrenMeta) => T): T {
        return this.db.transaction(() => {
            const state = this.read();
            const result = change(state);
            this.db
                .prepare(
                    `INSERT INTO schema_migrations_meta (key, value) VALUES (?, ?)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
                )
                .run(this.key, JSON.stringify(state));
            return result;
        })();
    }

    put(child: PersistedHiddenChild): void {
        this.mutate((state) => {
            state.active[child.role] = child;
        });
    }

    updateModel(child: PersistedHiddenChild, model: Model): PersistedHiddenChild {
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

    /** Forgets one retired child, called once its session is gone from the host. */
    prune(id: string): void {
        this.mutate((state) => {
            state.retired_children = state.retired_children.filter((child) => child.id !== id);
        });
    }
}

function modelKey(model: Model): string {
    return `${model.providerID}/${model.modelID}`;
}

function sameModel(left: Model, right: Model): boolean {
    return modelKey(left) === modelKey(right) && left.variant === right.variant;
}

function configuredHead(identity: HiddenRunIdentity): Model | undefined {
    const candidates = [identity.model, ...(identity.configuredModels ?? [])];
    for (const candidate of candidates) {
        const entry = toModelEntry(candidate);
        const parsed = entry ? parseProviderModel(entry.model) : null;
        if (parsed) return { ...parsed, ...(entry?.qualifier ? { variant: entry.qualifier } : {}) };
    }
    return undefined;
}

function roleFor(identity: HiddenRunIdentity): HiddenChildRole {
    return identity.kind === "dreamer-task" ? "dreamer" : "historian";
}

function roleTitle(role: HiddenChildRole): string {
    return role === "historian" ? "Magic Context historian" : "Magic Context dreamer";
}

function roleAgent(role: HiddenChildRole): string {
    return role === "historian" ? HIDDEN_HISTORIAN_AGENT : HIDDEN_DREAMER_AGENT;
}

function promptText(request: PromptArgs): string {
    const parts = request.body.parts;
    return Array.isArray(parts)
        ? parts
              .flatMap((part) =>
                  part &&
                  typeof part === "object" &&
                  typeof (part as { text?: unknown }).text === "string"
                      ? [(part as { text: string }).text]
                      : [],
              )
              .join("\n")
        : "";
}

/** Local estimate used only when a completed GA row omitted provider usage. */
function meter(system: string, prompt: string, text: string) {
    return {
        input: estimateTokens(system) + estimateTokens(prompt),
        output: estimateTokens(text),
        cacheRead: 0,
        cacheWrite: 0,
    };
}

function assistantOutcome(row: StoreRow<"assistant"> | undefined): AssistantOutcome | undefined {
    const outcome = row?.data.outcome;
    return outcome === "succeeded" || outcome === "failed" || outcome === "interrupted"
        ? outcome
        : undefined;
}

/**
 * OpenCode 2.0.5 settled provider failures with `finish: "error"`. Some converted 2.0.12 stores
 * carry the terminal outcome on the assistant row instead; native 2.0.12 idle rows are handled by
 * the poller. Either assistant shape proves the child is idle and safe to reuse.
 */
function settledProviderError(row: StoreRow<"assistant"> | undefined): boolean {
    const outcome = assistantOutcome(row);
    return (
        row !== undefined &&
        ((row.data.error !== undefined && typeof row.data.finish === "string") ||
            outcome === "failed" ||
            outcome === "interrupted")
    );
}

function successfulReusableAssistant(row: StoreRow<"assistant"> | undefined): boolean {
    return (
        row !== undefined &&
        (typeof row.data.finish === "string" || assistantOutcome(row) === "succeeded") &&
        row.data.error === undefined &&
        row.data.tokens !== undefined
    );
}

function assistantText(row: StoreRow<"assistant">): string | null {
    const text = (row.data.content ?? [])
        .flatMap((part) =>
            part.type === "text" && typeof part.text === "string" ? [part.text] : [],
        )
        .join("");
    return text.length > 0 ? text : null;
}

/**
 * A terminal provider or model-resolution failure persisted by the host, as opposed to an unsettled
 * dispatch error, timeout, or abort. Only this class keeps the now-idle child alive, so reuse does
 * not depend on wording that a later editor could accidentally change.
 */
export class HiddenProviderError extends Error {
    constructor(detail: string) {
        super(`Hidden completion provider error: ${detail}`);
        this.name = "HiddenProviderError";
    }
}

function errorText(value: unknown): string {
    if (value instanceof Error) return value.message;
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function requestModel(request: PromptArgs, current: Model): Model {
    const requested = request.body.model;
    if (
        requested &&
        typeof requested.providerID === "string" &&
        typeof requested.modelID === "string"
    ) {
        return {
            providerID: requested.providerID,
            modelID: requested.modelID,
            ...(typeof request.body.variant === "string" ? { variant: request.body.variant } : {}),
        };
    }
    return current;
}

function withReader<T>(
    openReader: () => HiddenChildRows & { close?: () => void },
    read: (reader: HiddenChildRows) => T,
): T {
    const reader = openReader();
    try {
        return read(reader);
    } finally {
        reader.close?.();
    }
}

async function sleepUntilPoll(signal: AbortSignal | undefined, deadline: number): Promise<void> {
    if (signal?.aborted) throw new Error("Hidden completion prompt aborted");
    const delay = Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()));
    if (delay <= 0) return;
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        const abort = () => {
            clearTimeout(timer);
            reject(new Error("Hidden completion prompt aborted"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        else
            setTimeout(() => {
                signal?.removeEventListener("abort", abort);
            }, delay);
    });
}

async function awaitAssistantRow(
    openReader: () => HiddenChildRows & { close?: () => void },
    readSessionError: () => Promise<unknown>,
    childID: string,
    afterSeq: number,
    deadline: number,
    signal?: AbortSignal,
): Promise<StoreRow<"assistant">> {
    for (;;) {
        const { assistant, idle } = withReader(openReader, (reader) => ({
            assistant: reader.latestAssistant(childID),
            idle: reader.latestIdle(childID),
        }));
        const newAssistant = assistant && assistant.seq > afterSeq ? assistant : undefined;
        const newIdle = idle && idle.seq > afterSeq ? idle : undefined;
        if (newIdle && (!newAssistant || newIdle.seq > newAssistant.seq)) {
            const outcome = newIdle.data.outcome;
            if (outcome === "failed" || outcome === "interrupted") {
                const sessionError = await readSessionError();
                const details = [
                    `outcome=${outcome}`,
                    `terminal_row=${errorText(newIdle)}`,
                    `session_error=${sessionError === undefined ? "unavailable" : errorText(sessionError)}`,
                ];
                throw new HiddenProviderError(details.join("; "));
            }
            if (outcome === "succeeded" && newAssistant) return newAssistant;
        }
        if (newAssistant) {
            const outcome = assistantOutcome(newAssistant);
            if (outcome === "failed" || outcome === "interrupted") {
                const sessionError = await readSessionError();
                const details = [
                    `outcome=${outcome}`,
                    `terminal_row=${errorText(newAssistant)}`,
                    `session_error=${sessionError === undefined ? "unavailable" : errorText(sessionError)}`,
                ];
                throw new HiddenProviderError(details.join("; "));
            }
            if (newAssistant.data.error !== undefined) {
                throw new HiddenProviderError(errorText(newAssistant.data.error));
            }
            if (typeof newAssistant.data.finish === "string" || outcome === "succeeded") {
                return newAssistant;
            }
        }
        if (Date.now() >= deadline) {
            throw new Error("Hidden completion timed out waiting for a persisted assistant row");
        }
        await sleepUntilPoll(signal, deadline);
    }
}

export async function createV2HiddenCompletionExecutor(
    host: HiddenChildHost,
    options: V2HiddenCompletionOptions,
): Promise<HiddenCompletionExecutor> {
    const runs = new WeakMap<HiddenRunHandle, RunState>();
    const store = new HiddenChildStateStore(options.db, options.projectIdentity);
    const generation = options.generation ?? "opencode2";
    const roleTails = new Map<HiddenChildRole, Promise<void>>();

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

    const removeChildSession = async (child: RetirableChild): Promise<void> => {
        const remove = host.remove;
        if (!remove) return;
        try {
            await remove({
                sessionID: child.id,
                ...(child.owner === undefined ? {} : { owner: child.owner }),
            });
        } catch (error) {
            // The host was unreachable, refused, or is not the one that created this child. Keep
            // the entry so a later sweep retries it; cleanup is never allowed to fail the hidden
            // run that triggered it.
            if (error instanceof HostServiceUnavailable) {
                // Nothing in this process can delete it. Say so once, everywhere the user looks,
                // rather than repeating an unactionable line in the log on every sweep.
                if (declareHostLimitation("hidden_cleanup_unbound")) {
                    note(
                        `[magic-context] hidden child ${child.id} has no owner-bound deletion route and stays recorded for retry: ${errorText(error)}`,
                    );
                }
                return;
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
    const scheduleRemoval = (child: RetirableChild): void => {
        if (!host.remove || queued.has(child.id)) return;
        queued.add(child.id);
        removals = removals
            .then(() => pause(spacing))
            .then(() => removeChildSession(child))
            .catch(() => {})
            .finally(() => {
                queued.delete(child.id);
            });
    };

    const retireChild = (child: PersistedHiddenChild, reason: string): void => {
        store.retire(child, reason);
        scheduleRemoval(child);
    };

    // Boot sweep. Anything left over from an earlier process — including the backlog built up
    // before retirement deleted anything — is drained here, spaced like every other removal.
    for (const child of persisted.retired_children) scheduleRemoval(child);

    const acquireRole = async (role: HiddenChildRole): Promise<() => void> => {
        const previous = roleTails.get(role) ?? Promise.resolve();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const tail = previous.then(() => gate);
        roleTails.set(role, tail);
        await previous;
        return () => {
            release();
            if (roleTails.get(role) === tail) roleTails.delete(role);
        };
    };

    const resolveHead = async (identity: HiddenRunIdentity): Promise<Model> => {
        const configured = configuredHead(identity);
        if (configured) return configured;
        if (!identity.parentSessionId) {
            throw new HiddenCompletionRefusal(
                "hidden_model_unsupported",
                "Hidden completion requires a configured model or an existing parent session model",
                true,
            );
        }
        const parent = await host.get({ sessionID: identity.parentSessionId });
        if (!parent.model) {
            throw new HiddenCompletionRefusal(
                "hidden_model_unsupported",
                "Hidden completion could not resolve the parent session model",
                true,
            );
        }
        return {
            providerID: parent.model.providerID,
            modelID: parent.model.id,
            ...(parent.model.variant ? { variant: parent.model.variant } : {}),
        };
    };

    const switchChildModel = async (run: RunState, requested: Model): Promise<void> => {
        if (sameModel(run.child.model, requested)) return;
        await host.switchModel({
            sessionID: run.child.id,
            model: {
                providerID: requested.providerID,
                id: requested.modelID,
                ...(requested.variant ? { variant: requested.variant } : {}),
            },
        });
        run.child = store.updateModel(run.child, requested);
    };

    const retire = (run: RunState, reason: string): void => {
        if (run.retired) return;
        retireChild(run.child, reason);
        run.retired = true;
    };

    const interruptAndRetire = async (run: RunState, reason: string): Promise<void> => {
        try {
            await host.interrupt({ sessionID: run.child.id });
        } finally {
            retire(run, reason);
        }
    };

    return {
        capabilities: { tools: false, harness: "opencode2" },
        async open(identity) {
            const role = roleFor(identity);
            const releaseRole = await acquireRole(role);
            let openedChild: PersistedHiddenChild | undefined;
            try {
                await options.ensureAgent?.();
                const head = await resolveHead(identity);
                let active = store.read().active[role];
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
                        idleOutcome === "failed" ||
                        idleOutcome === "interrupted" ||
                        ((idleOutcome === undefined || idleOutcome === "succeeded") &&
                            (successfulReusableAssistant(latest.assistant) ||
                                settledProviderError(latest.assistant)));
                    if (!reusable) {
                        retireChild(active, "newest-assistant-not-reusable");
                        active = undefined;
                    }
                }
                if (!active) {
                    const title = roleTitle(role);
                    const created = await host.create({
                        title,
                        agent: roleAgent(role),
                        model: {
                            providerID: head.providerID,
                            id: head.modelID,
                            ...(head.variant ? { variant: head.variant } : {}),
                        },
                        location: { directory: identity.directory },
                        metadata: { magic_context: "hidden-run", role },
                    });
                    if (!created.id)
                        throw new Error("OpenCode 2 did not return a child session id");
                    // Bind the child to the host that is creating it, now, while that host is
                    // demonstrably this process. Deleting it later goes through this binding and
                    // nothing else.
                    const owner = resolveOwner();
                    active = {
                        id: created.id,
                        role,
                        generation,
                        title,
                        model: head,
                        created_at: Date.now(),
                        title_reasserted: false,
                        ...(owner === undefined ? {} : { owner }),
                    };
                    store.put(active);
                    options.hook.registerChild(active.id);
                }
                openedChild = active;
                const handle = { id: active.id, childSessionId: active.id };
                const run: RunState = {
                    identity,
                    role,
                    child: active,
                    releaseRole,
                    failed: false,
                    unsettledFailure: false,
                    retired: false,
                };
                runs.set(handle, run);
                await switchChildModel(run, head);
                return handle;
            } catch (error) {
                if (openedChild) retireChild(openedChild, "hidden-run-open-failed");
                releaseRole();
                throw error;
            }
        },
        async attempt(handle, request) {
            const run = runs.get(handle);
            if (!run) throw new Error("Unknown hidden completion run");
            if (request.signal?.aborted) {
                await interruptAndRetire(run, "aborted-before-prompt");
                throw new Error("Hidden completion prompt aborted");
            }

            const requested = requestModel(request, run.child.model);
            await switchChildModel(run, requested);
            const baseline = withReader(options.openReader, (reader) =>
                reader.latestSequence(run.child.id),
            );
            const marker = `mc:hidden:${crypto.randomUUID()}:${crypto.randomUUID()}`;
            const attempt: HiddenChildAttempt = {
                childSessionId: run.child.id,
                identity: run.identity,
                request,
                shaped: false,
            };
            options.hook.registerAttempt(marker, attempt);
            const deadline = Date.now() + run.identity.timeoutMs;
            let abortReject!: (error: Error) => void;
            const aborted = new Promise<never>((_resolve, reject) => {
                abortReject = reject;
            });
            const onAbort = () => {
                void interruptAndRetire(run, "prompt-aborted").finally(() =>
                    abortReject(new Error("Hidden completion prompt aborted")),
                );
            };
            const deadlineTimer = setTimeout(
                () => {
                    void interruptAndRetire(run, "prompt-timeout").finally(() =>
                        abortReject(new Error("Hidden completion prompt timed out")),
                    );
                },
                Math.max(0, deadline - Date.now()),
            );
            request.signal?.addEventListener("abort", onAbort, { once: true });
            try {
                await Promise.race([
                    host.prompt({ sessionID: run.child.id, text: marker }),
                    aborted,
                ]);
                await Promise.race([host.wait({ sessionID: run.child.id }), aborted]);
                clearTimeout(deadlineTimer);
                const row = await Promise.race([
                    awaitAssistantRow(
                        options.openReader,
                        async () => {
                            try {
                                return (await host.get({ sessionID: run.child.id })).error;
                            } catch {
                                return undefined;
                            }
                        },
                        run.child.id,
                        baseline,
                        deadline,
                        request.signal,
                    ),
                    aborted,
                ]);
                if (!attempt.shaped) {
                    throw new HiddenCompletionRefusal(
                        "hidden_prompt_unrecognized",
                        "Host did not dispatch the hidden child context hook",
                        true,
                    );
                }
                if (!run.child.title_reasserted) {
                    await host.update({ sessionID: run.child.id, title: run.child.title });
                    run.child = store.markTitleReasserted(run.child);
                }
                const text = assistantText(row);
                const system =
                    typeof request.body.system === "string"
                        ? request.body.system
                        : run.identity.system;
                const tokens = row.data.tokens;
                const tokenNumber = (value: unknown): number | undefined =>
                    typeof value === "number" && Number.isFinite(value) ? value : undefined;
                const reportedInput = tokenNumber(tokens?.input);
                const reportedOutput = tokenNumber(tokens?.output);
                run.completion = {
                    text,
                    reasoning: null,
                    // If either side is numeric, retain the provider's partial usage
                    // and floor omitted components to zero. With no numeric usage,
                    // use the local meter so budget accounting remains finite.
                    usage:
                        reportedInput !== undefined || reportedOutput !== undefined
                            ? {
                                  input: reportedInput ?? 0,
                                  output: reportedOutput ?? 0,
                                  cacheRead: tokenNumber(tokens?.cache?.read) ?? 0,
                                  cacheWrite: tokenNumber(tokens?.cache?.write) ?? 0,
                              }
                            : meter(system, promptText(request), text ?? ""),
                    lengthCapped: ["length", "max_tokens"].includes(row.data.finish ?? ""),
                    providerId: row.data.model?.providerID ?? requested.providerID,
                    modelId: row.data.model?.id ?? requested.modelID,
                };
            } catch (error) {
                run.failed = true;
                if (!(error instanceof HiddenProviderError)) {
                    run.unsettledFailure = true;
                }
                if (request.signal?.aborted && !run.retired) {
                    await interruptAndRetire(run, "prompt-aborted");
                } else if (
                    error instanceof Error &&
                    error.message.includes("timed out") &&
                    !run.retired
                ) {
                    await interruptAndRetire(run, "prompt-timeout");
                }
                throw error;
            } finally {
                clearTimeout(deadlineTimer);
                request.signal?.removeEventListener("abort", onAbort);
                options.hook.releaseAttempt(marker);
            }
        },
        async collect(handle) {
            const completion = runs.get(handle)?.completion;
            if (!completion) throw new Error("Hidden completion has no settled output");
            return completion;
        },
        async close(handle, settlement) {
            if (!handle) return;
            const run = runs.get(handle);
            if (!run) return;
            try {
                // A run that failed only on settled provider errors keeps its child: retiring it would
                // create a new session per failed run (with a pool at its quota, one per historian
                // trigger, indefinitely). The caller reports promptSettled=false after any failed
                // attempt, so it cannot tell this case apart; the run's own record of every failure
                // being a persisted provider error row (the child is idle) is what decides.
                const reusable = run.failed && !run.unsettledFailure;
                if (!run.completion && (run.failed || !settlement.promptSettled) && !reusable) {
                    retire(run, "hidden-run-failed");
                }
            } finally {
                runs.delete(handle);
                run.releaseRole();
            }
        },
    };
}
