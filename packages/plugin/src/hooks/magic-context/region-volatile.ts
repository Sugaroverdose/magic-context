// Unit 2 volatile segment carrier (region-only migration Task 1).
//
// The frozen system region carries only what was true at its capture. The
// delta classes that used to live in the head-era m[1] — memory mutations,
// compartments published after the capture, memories that overflow the frozen
// region panel, profile deltas, docs deltas — render here instead: a small
// per-session segment stored beside the region and served at the tail of
// system[0] AFTER the region bytes. The segment is absorbed by the next
// natural fold (persistCachedM0 clears it in the fold transaction).
//
// Replay-only law: serveRegionVolatile decodes persisted bytes and performs
// zero computation; recomputation happens only on passes that already hold
// the bust permission (transform-postprocess-phase bust lane). Region and
// volatile bytes are pure functions of the store up to the captured
// watermark — no timestamps, no randomness.

import {
    getMemoriesByProject,
    getMemoriesByProjects,
} from "../../features/magic-context/memory/storage-memory";
import type { Memory } from "../../features/magic-context/memory/types";
import { isNoContentCompartment } from "../../features/magic-context/no-content-compartment";
import { readProjectDocsCanonical } from "../../features/magic-context/storage";
import { writeRegionVolatile } from "../../features/magic-context/storage-meta-shared";
import { decodeSystemRegionRow } from "../../features/magic-context/system-region";
import type { SessionMeta } from "../../features/magic-context/types";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { renderCompartmentAtTier } from "./decay-render";
import {
    DEFAULT_MEMORY_BUDGET_TOKENS,
    DEFAULT_USER_PROFILE_BUDGET_TOKENS,
    getGlobalUserProfileVersion,
    type M0M1RenderOptions,
    type MemoryRenderOptions,
    readNewCompartments,
    renderMemoryBlockV2,
    renderMemoryUpdatesBlock,
    renderUserProfileBlock,
    resolveWorkspaceRenderContext,
    safeGetActiveUserMemories,
    sourceNamesForMemories,
    trimMemoriesToBudgetV2,
    trimUserMemoriesToBudget,
    withCompartmentDates,
} from "./region-render";

/** The region row the volatile bytes were rendered against. */
export interface RegionVolatileWatermark {
    maxMemoryId: number;
    maxCompartmentSeq: number;
    maxMemoryMutationId: number;
    projectUserProfileVersion: number;
    projectDocsHash: string;
    /** cached_m0_materialized_at of the region row this segment was rendered for. */
    materializedAt: number;
    /** Memory ids the region's project-memory panel actually rendered. */
    renderedMemoryIds: readonly number[];
}

export interface RegionVolatileRender {
    text: string;
    memoryUpdateCount: number;
    compartmentCount: number;
}

/**
 * Render the volatile segment for everything the store holds beyond the
 * captured region watermark. Byte-deterministic: a pure function of (store,
 * watermark). Returns "" when nothing is pending — the empty segment is the
 * absorbed state, served as no tail at all (the never-empty floor belongs to
 * the region; the volatile segment has no placeholder duty).
 */
export function renderRegionVolatile(
    options: M0M1RenderOptions,
    watermark: RegionVolatileWatermark,
): RegionVolatileRender {
    const blocks: string[] = [];
    let memoryUpdateCount = 0;
    let compartmentCount = 0;

    const workspace = resolveWorkspaceRenderContext({
        db: options.db,
        projectPath: options.projectPath,
        workspaceIdentitySet: options.workspaceIdentitySet,
    });

    const eligibleMemories: Memory[] = options.projectPath
        ? workspace.isWorkspaced
            ? getMemoriesByProjects(
                  options.db,
                  workspace.expandedIdentities,
                  ["active", "permanent"],
                  watermark.materializedAt,
                  workspace.ownIdentities,
                  workspace.shareCategories,
              )
            : getMemoriesByProject(
                  options.db,
                  options.projectPath,
                  ["active", "permanent"],
                  watermark.materializedAt,
              )
        : [];
    const eligibleMemoryIds = new Set(eligibleMemories.map((memory) => memory.id));

    const memoryUpdates = renderMemoryUpdatesBlock({
        db: options.db,
        projectPath: options.projectPath,
        workspace,
        afterId: watermark.maxMemoryMutationId,
        renderedMemoryIds: watermark.renderedMemoryIds,
        eligibleMemoryIds,
    });
    if (memoryUpdates.block) {
        blocks.push(memoryUpdates.block);
        memoryUpdateCount = memoryUpdates.count;
    }

    const newCompartments = withCompartmentDates(
        options.db,
        options.sessionId,
        readNewCompartments(options.db, options.sessionId, watermark.maxCompartmentSeq).filter(
            (compartment) => !isNoContentCompartment(compartment),
        ),
        options.temporalAwareness,
    );
    if (newCompartments.length > 0) {
        blocks.push(
            `<new-compartments>\n${newCompartments
                .map((compartment) => renderCompartmentAtTier(compartment, 1))
                .join("\n\n")}\n</new-compartments>`,
        );
        compartmentCount = newCompartments.length;
    }

    const forcedMemoryIds = new Set(memoryUpdates.forcedMemoryIds);
    const regionRendered = new Set(watermark.renderedMemoryIds);
    const newMemories = eligibleMemories.filter(
        (memory) => memory.id > watermark.maxMemoryId && !forcedMemoryIds.has(memory.id),
    );
    const newMemoryRenderOptions: MemoryRenderOptions = {
        sourceNameByMemoryId: sourceNamesForMemories({
            memories: eligibleMemories,
            projectPath: options.projectPath,
            workspace,
        }),
    };
    const trimmedNewMemories = trimMemoriesToBudgetV2(
        options.sessionId,
        newMemories,
        Math.max(
            1,
            Math.floor(
                (options.memoryInjectionBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS) * 0.25,
            ),
        ),
        newMemoryRenderOptions,
    ).renderOrder;
    // The overflow set beyond the frozen region panel: memories newer than the
    // capture that never reached the region's project-memory block.
    const deltaMemories = [
        ...trimmedNewMemories.filter((memory) => !regionRendered.has(memory.id)),
        ...eligibleMemories.filter((memory) => forcedMemoryIds.has(memory.id)),
    ];
    const newMemoriesBlock = renderMemoryBlockV2(
        deltaMemories,
        "new-memories",
        newMemoryRenderOptions,
    );
    if (newMemoriesBlock) blocks.push(newMemoriesBlock);

    const currentUserProfileVersion = getGlobalUserProfileVersion(options.db);
    if (
        options.memoryEnabled !== false &&
        currentUserProfileVersion !== watermark.projectUserProfileVersion
    ) {
        const profileBlock = renderUserProfileBlock(
            trimUserMemoriesToBudget(
                safeGetActiveUserMemories(options.db),
                Math.max(
                    1,
                    Math.floor(
                        (options.userProfileBudgetTokens ?? DEFAULT_USER_PROFILE_BUDGET_TOKENS) *
                            0.25,
                    ),
                ),
            ),
            "new-user-profile",
        );
        if (profileBlock) blocks.push(profileBlock);
    }

    const docsDelta = renderDocsDeltaBlock(options, watermark);
    if (docsDelta) blocks.push(docsDelta);

    if (blocks.length === 0) {
        return { text: "", memoryUpdateCount: 0, compartmentCount: 0 };
    }
    return {
        text: `<session-history-since>\n${blocks.join("\n")}\n</session-history-since>`,
        memoryUpdateCount,
        compartmentCount,
    };
}

/**
 * Docs delta: the project-docs panel is region-resident and the docs hash no
 * longer rotates the region (Task 3), so a docs edit rides here until the
 * next fold absorbs the new bytes into the region panel.
 */
function renderDocsDeltaBlock(
    options: M0M1RenderOptions,
    watermark: RegionVolatileWatermark,
): string {
    if (!options.projectDirectory || options.injectDocs === false) return "";
    const canonical = readProjectDocsCanonical(options.projectDirectory);
    if (!canonical.renderedBlock) return "";
    if (canonical.canonicalHash === watermark.projectDocsHash) return "";
    return canonical.renderedBlock;
}

/**
 * The one region-volatile codec: stored bytes → served tail text, null when
 * absent/empty. Shared by the store decode and the serve site so the two can
 * never drift.
 */
export function decodeRegionVolatileBytes(
    value: Buffer | Uint8Array | null | undefined,
): string | null {
    if (value === null || value === undefined) return null;
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return buffer.length === 0 ? null : buffer.toString("utf8");
}

/**
 * Serve-side decode: stored bytes verbatim, zero computation, zero live
 * reads beyond the row itself. The epoch guard (a segment must name the
 * region row it was rendered against) lives at the append site, which
 * already holds the session meta.
 */
export function serveRegionVolatile(db: Database, sessionId: string): string | null {
    const row = db
        .prepare("SELECT region_volatile_bytes FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { region_volatile_bytes: Buffer | Uint8Array | null } | undefined;
    return decodeRegionVolatileBytes(row?.region_volatile_bytes);
}

function readMemoryBlockIds(db: Database, sessionId: string): number[] {
    const row = db
        .prepare("SELECT memory_block_ids FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { memory_block_ids: string | null } | undefined;
    if (!row?.memory_block_ids) return [];
    try {
        const parsed = JSON.parse(row.memory_block_ids) as unknown;
        return Array.isArray(parsed) ? (parsed as number[]) : [];
    } catch {
        return [];
    }
}

/**
 * The bust-lane recompute entry (Task 1 Step 4): called only from a pass that
 * already holds the bust permission. Renders the segment against the stored
 * region row's captured watermark and persists it only when the bytes moved;
 * every other pass serves the stored bytes verbatim. When the fold executed
 * this pass the caller skips this — persistCachedM0 absorbed the segment in
 * the fold transaction.
 */
export function recomputeRegionVolatileSegment(args: {
    db: Database;
    sessionId: string;
    meta: SessionMeta;
    options: M0M1RenderOptions;
}): RegionVolatileRender | null {
    const { db, sessionId, meta } = args;
    if (meta.cachedM0MaterializedAt === null) return null;
    if (decodeSystemRegionRow(meta.cachedM0Bytes ?? null) === null) return null;
    const watermark: RegionVolatileWatermark = {
        maxMemoryId: meta.cachedM0MaxMemoryId ?? 0,
        maxCompartmentSeq: meta.cachedM0MaxCompartmentSeq ?? 0,
        maxMemoryMutationId: meta.cachedM0MaxMemoryMutationId ?? 0,
        projectUserProfileVersion: meta.cachedM0ProjectUserProfileVersion ?? 0,
        projectDocsHash: meta.cachedM0ProjectDocsHash ?? "",
        materializedAt: meta.cachedM0MaterializedAt,
        renderedMemoryIds: readMemoryBlockIds(db, sessionId),
    };
    const rendered = renderRegionVolatile(args.options, watermark);
    const stored = decodeRegionVolatileBytes(meta.regionVolatileBytes);
    if (rendered.text === (stored ?? "")) return null;
    writeRegionVolatile(db, sessionId, rendered.text, meta.cachedM0MaterializedAt);
    sessionLog(
        sessionId,
        `region-volatile recomputed bytes=${rendered.text.length} updates=${rendered.memoryUpdateCount} compartments=${rendered.compartmentCount}`,
    );
    return rendered;
}
