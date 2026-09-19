import {
    hostMemoryIdentityForModuleId,
    moduleMemoryIdentityForHostId,
} from "../features/magic-context/context-authority";
import { getMemoriesByIds, type Memory } from "../features/magic-context/memory";
import {
    createMemoryVisibilityPolicy,
    type MemoryVisibilityPolicy,
} from "../features/magic-context/memory/memory-visibility";
import type { Database } from "../shared/sqlite";

export interface ModuleMemoryOperation {
    action: string;
    module_id?: number;
    canonical_module_id?: number;
    superseded_module_ids?: number[];
    category?: string;
}

export function unmappedMemoryIdMessage(id: number): string {
    return `Error: memory id ${id} has no module mapping yet — it was written seconds ago or the mirror is behind; retry or use the id shown in <project-memory>.`;
}

/**
 * How one id from <project-memory> can be reached while the module holds
 * memory authority.
 *
 * The module mirrors only the authority project's own rows, but the rendered
 * block also carries workspace-shared memories owned by OTHER projects. Those
 * ids are real host rows with no module counterpart, and they never gain one —
 * so "no mapping" is three different situations needing three different reader
 * actions, not one retry message.
 */
export type RustMemoryIdRoute =
    /** Mirrored row of this project: the module can address it. */
    | { kind: "module"; hostId: number; moduleId: number }
    /** Another project's memory, shared with this workspace: readable, never writable here. */
    | { kind: "host"; hostId: number }
    /** This project's own row whose mirror mapping has not arrived yet: retrying helps. */
    | { kind: "pending"; hostId: number }
    /** No row, or one this project may not see. One text for both, so neither can be probed for. */
    | { kind: "unknown"; hostId: number };

/** Transient: the row is this project's and its mapping is still in flight. */
export function pendingMemoryIdLine(id: number): string {
    return `id ${id}: not mirrored yet — it was written seconds ago or the mirror is behind; retry.`;
}

/** Permanent: a workspace-shared row owned elsewhere. Retrying can never change it. */
export function foreignMemoryIdLine(id: number): string {
    return `id ${id}: not owned by this project's module — read-only here; retrying will not help.`;
}

/** Shared by "no such row" and "not visible from here". */
export function unknownMemoryIdLine(id: number): string {
    return `id ${id}: not found or not visible from this project`;
}

export function memoryIdRouteLine(route: RustMemoryIdRoute): string {
    if (route.kind === "pending") return pendingMemoryIdLine(route.hostId);
    if (route.kind === "host") return foreignMemoryIdLine(route.hostId);
    return unknownMemoryIdLine(route.hostId);
}

export interface RustMemoryIdRouting {
    routes: RustMemoryIdRoute[];
    /** Host rows behind every `host` route, so the caller can render them. */
    hostReadable: Map<number, Memory>;
}

/**
 * Classify each requested host id for the Rust-backed ctx_memory facade.
 *
 * A mirror mapping only counts when it belongs to THIS project's module: one
 * context store can hold two projects under module authority, and routing a
 * neighbouring project's mapped row into this project's module call would
 * address the wrong store.
 */
export function routeHostMemoryIds(args: {
    db: Database;
    projectIdentity: string;
    hostIds: readonly number[];
    visibility?: MemoryVisibilityPolicy;
}): RustMemoryIdRouting {
    const { db, projectIdentity } = args;
    const hostIds = args.hostIds.filter((id) => Number.isInteger(id));
    if (hostIds.length === 0) return { routes: [], hostReadable: new Map() };

    const unmapped: number[] = [];
    const mapped = new Map<number, number>();
    for (const hostId of hostIds) {
        const identity = moduleMemoryIdentityForHostId(db, hostId);
        if (identity && identity.moduleProject === projectIdentity) {
            mapped.set(hostId, identity.moduleRowId);
        } else {
            unmapped.push(hostId);
        }
    }

    const rowsById = new Map<number, Memory>();
    if (unmapped.length > 0) {
        for (const memory of getMemoriesByIds(db, unmapped)) rowsById.set(memory.id, memory);
    }
    const visibility = args.visibility ?? createMemoryVisibilityPolicy(db, projectIdentity);

    const hostReadable = new Map<number, Memory>();
    const routes = hostIds.map((hostId): RustMemoryIdRoute => {
        const moduleId = mapped.get(hostId);
        if (moduleId !== undefined) return { kind: "module", hostId, moduleId };
        const memory = rowsById.get(hostId);
        if (!memory || !visibility.visible(memory)) return { kind: "unknown", hostId };
        // Own row without a mapping: the module has not published it yet, or the
        // mirror is behind. That is the one genuinely transient case.
        if (visibility.owned(memory)) return { kind: "pending", hostId };
        hostReadable.set(hostId, memory);
        return { kind: "host", hostId };
    });
    return { routes, hostReadable };
}

export interface RustMemoryRoutingPlan {
    /** Host ids the module call should carry, in request order. */
    moduleHostIds: number[];
    /** Host ids to serve from the host read model instead of the module. */
    hostReadIds: number[];
    /** One line per id the module cannot address, in request order. */
    unaddressableLines: string[];
    /** True when the module must not be called at all and the reply is built locally. */
    skipModuleCall: boolean;
    /** Set when the whole call is refused without touching the module. */
    refusal: string | null;
}

const MUTATION_ACTIONS = new Set(["write", "update", "archive", "merge"]);

/**
 * Decide what the module is asked to do once the ids are classified.
 *
 * Reads serve every id they can and report the rest per id, so one shared
 * memory in a batch no longer costs the caller the ids that did resolve.
 * Mutations never reach for the host row: the module owns those rows while it
 * holds authority, and a host-side write behind its back would be overwritten
 * by the next mirror page. `merge` is all-or-nothing because a partial merge
 * would silently drop a source the caller asked to consolidate.
 */
export function planRustMemoryRouting(args: {
    action: string;
    routes: readonly RustMemoryIdRoute[];
}): RustMemoryRoutingPlan {
    const { action, routes } = args;
    const moduleHostIds = routes
        .filter((route) => route.kind === "module")
        .map((route) => route.hostId);
    const hostReadIds = routes
        .filter((route) => route.kind === "host")
        .map((route) => route.hostId);
    const unresolved = routes.filter((route) => route.kind !== "module");
    const plan: RustMemoryRoutingPlan = {
        moduleHostIds,
        hostReadIds,
        unaddressableLines: [],
        skipModuleCall: false,
        refusal: null,
    };
    if (unresolved.length === 0) return plan;

    if (!MUTATION_ACTIONS.has(action)) {
        // A host route is served locally, so only pending and unknown ids are
        // left without an outcome for a read.
        plan.unaddressableLines = unresolved
            .filter((route) => route.kind !== "host")
            .map(memoryIdRouteLine);
        plan.skipModuleCall = moduleHostIds.length === 0;
        return plan;
    }
    // For a mutation a readable foreign row is still refused, and says why.
    const mutationLines = unresolved.map((route) =>
        route.kind === "host" ? foreignMemoryIdLine(route.hostId) : memoryIdRouteLine(route),
    );
    if (action === "merge") {
        plan.hostReadIds = [];
        plan.refusal = [...mutationLines, "No merge was performed."].join("\n");
        return plan;
    }
    plan.hostReadIds = [];
    if (moduleHostIds.length === 0) {
        plan.refusal = mutationLines.join("\n");
        return plan;
    }
    // `archive` is per-id independent: archive what the module owns, report the rest.
    plan.unaddressableLines = mutationLines;
    return plan;
}

export function translateHostMemoryIds(
    db: Database,
    hostIds: readonly number[],
): { moduleIds: number[] } | { error: string } {
    const moduleIds: number[] = [];
    for (const hostId of hostIds) {
        const identity = moduleMemoryIdentityForHostId(db, hostId);
        if (!identity) return { error: unmappedMemoryIdMessage(hostId) };
        moduleIds.push(identity.moduleRowId);
    }
    return { moduleIds };
}

export function moduleMemoryOperation(response: unknown, depth = 0): ModuleMemoryOperation | null {
    if (depth > 4 || response === null || typeof response !== "object") return null;
    if (Array.isArray(response)) {
        for (const item of response) {
            const operation = moduleMemoryOperation(item, depth + 1);
            if (operation) return operation;
        }
        return null;
    }
    const record = response as Record<string, unknown>;
    if (
        record.memory_operation !== null &&
        typeof record.memory_operation === "object" &&
        typeof (record.memory_operation as Record<string, unknown>).action === "string"
    ) {
        return record.memory_operation as unknown as ModuleMemoryOperation;
    }
    return moduleMemoryOperation(record.result, depth + 1);
}

export function translateModuleMemoryMutationReply(args: {
    db: Database;
    moduleProject: string;
    response: unknown;
    requestedHostIds: readonly number[];
    requestedCategory?: string;
}): string | null {
    const operation = moduleMemoryOperation(args.response);
    if (operation?.action === "write" && operation.module_id !== undefined) {
        const identity = hostMemoryIdentityForModuleId(
            args.db,
            args.moduleProject,
            operation.module_id,
        );
        const category = operation.category ?? args.requestedCategory;
        return identity
            ? `Saved memory [ID: ${identity.contextRowId}] in ${category}.`
            : `Saved memory in ${category}. Its id will appear in <project-memory> on the next pass.`;
    }
    if (operation?.action === "merge" && operation.canonical_module_id !== undefined) {
        const canonical = hostMemoryIdentityForModuleId(
            args.db,
            args.moduleProject,
            operation.canonical_module_id,
        );
        const superseded = (operation.superseded_module_ids ?? [])
            .map(
                (moduleId) =>
                    hostMemoryIdentityForModuleId(args.db, args.moduleProject, moduleId)
                        ?.contextRowId,
            )
            .filter((id): id is number => id !== undefined);
        const category = operation.category ?? args.requestedCategory;
        if (canonical) {
            return `Merged memories [${args.requestedHostIds.join(", ")}] into canonical memory [ID: ${canonical.contextRowId}] in ${category}; superseded [${superseded.join(", ")}].`;
        }
        return `Merged memories [${args.requestedHostIds.join(", ")}] into a canonical memory in ${category}. Its id will appear in <project-memory> on the next pass.`;
    }
    return null;
}
