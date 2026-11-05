// Unit 2 volatile segment carrier (region-only migration Task 1).
//
// The frozen system region carries only what was true at its capture. The
// delta classes that used to live in the head-era m[1] — memory mutations,
// compartments published after the capture, memories that overflow the frozen
// region panel, profile deltas, docs deltas — render here instead: a small
// per-session segment stored beside the region and served at the tail of
// system[0] AFTER the region bytes. The segment is absorbed by the next
// natural fold (the fold-row persist clears it inside the fold transaction).
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
    /** Memory ids this segment renders (overflow set + forced mutation rows). */
    memoryIds: number[];
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
    /**
     * Pre-resolved canonical docs (the fold owns one read per boundary pass —
     * the docs-read-count law). Omitted on bust-lane recomputation, which is
     * the pass's only docs reader.
     */
    docsOverride?: { renderedBlock: string; canonicalHash: string },
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
        ...trimmedNewMemories,
        ...eligibleMemories.filter((memory) => forcedMemoryIds.has(memory.id)),
    ];
    // Deduped identity of the memories this segment renders, for the
    // session_meta.memory_block_* accounting (ctx_search's hide-already-visible
    // filter reads it — region panel ids ∪ volatile ids).
    const memoryIds = [...new Set(deltaMemories.map((memory) => memory.id))];
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

    const docsDelta = renderDocsDeltaBlock(options, watermark, docsOverride);
    if (docsDelta) blocks.push(docsDelta);

    if (blocks.length === 0) {
        return { text: "", memoryUpdateCount: 0, compartmentCount: 0, memoryIds: [] };
    }
    return {
        text: `<session-history-since>\n${blocks.join("\n")}\n</session-history-since>`,
        memoryUpdateCount,
        compartmentCount,
        memoryIds,
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
    docsOverride?: { renderedBlock: string; canonicalHash: string },
): string {
    if (!options.projectDirectory || options.injectDocs === false) return "";
    const canonical =
        docsOverride ?? readProjectDocsCanonical(options.projectDirectory);
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
 * THE production serve reader (Unit 2 Task 1 contract): decode of persisted
 * bytes plus the epoch guard — a segment is servable only when its watermark
 * names the region row being served (an older segment is refused). Called
 * from the serve site with the session meta it already loaded: stored bytes
 * verbatim, zero computation, zero live reads beyond the row. The fold and
 * the bust-lane recompute are the only writers; this is the only reader.
 */
export function serveRegionVolatile(meta: SessionMeta): string | null {
    if (
        meta.regionVolatileWatermark === null ||
        meta.cachedM0MaterializedAt === null ||
        meta.regionVolatileWatermark !== meta.cachedM0MaterializedAt
    ) {
        return null;
    }
    return decodeRegionVolatileBytes(meta.regionVolatileBytes);
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
 * this pass the caller skips this — the fold-row persist absorbed the segment in
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
    // Hide-filter accounting: the ctx_search hard filter (tools.ts
    // getVisibleMemoryIds) must hide everything the wire shows. The fold owns
    // the exact re-derivation (panel ids ∪ fold-volatile ids); the bust-lane
    // recompute only grows the set for the current region epoch — merged
    // volatile ids become stale-excess at most until the next fold, which
    // rewrites the row wholesale.
    if (rendered.memoryIds.length > 0) {
        const prior = new Set(readMemoryBlockIds(db, sessionId));
        for (const id of rendered.memoryIds) prior.add(id);
        const ids = [...prior].sort((left, right) => left - right);
        db.prepare(
            "UPDATE session_meta SET memory_block_count = ?, memory_block_ids = ? WHERE session_id = ?",
        ).run(ids.length, JSON.stringify(ids), sessionId);
    }
    sessionLog(
        sessionId,
        `region-volatile recomputed bytes=${rendered.text.length} updates=${rendered.memoryUpdateCount} compartments=${rendered.compartmentCount}`,
    );
    return rendered;
}
