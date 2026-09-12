# Pi over-window investigation

Source references below refer to the pre-fix snapshot `0ebe5b8df858`. Evidence is the read-only capture of session `019de471-4fdc-762d-9286-624dfad0b5fe`; no live database was opened or changed.

## Wire composition

`005-req.json`, independently parsed: 2,889 input items. Bytes below are UTF-8 compact JSON per item (excluding array separators), not tokenizer estimates. The operator's ~769 KB figure includes pretty-print whitespace.

| Kind | Count | Compact bytes |
| --- | ---: | ---: |
| user | 60 | 256,389 |
| function_call | 1,403 | 280,408 |
| function_call_output | 1,403 | 148,542 |
| assistant | 18 | 21,768 |
| reasoning | 5 | 16,754 |

Tool arcs occupy 428,950 compact bytes; outputs average 106 bytes including their envelope. Removing only output payload cannot solve this shape. Byte mass is not an exact token count.

## 1. Full drops are skeletons in Pi (confirmed defect)

Shared `apply-operations.ts:87-96,134-155` chooses truncated mode for the newest 20 tool tags at **drop time**, full mode otherwise. `174-210` replays persisted modes. Contrary to the premise that OpenCode retains only 20 skeletons forever, the shared documented policy freezes modes: old truncated drops are not demoted on later defer passes (`28-35`).

Pi's `shared/tag-transcript.ts:1060-1067` implements full drop by calling `replaceWithSentinel` on BOTH occurrences. Pi `transcript-pi.ts:757-802` deliberately retains the call id/name/arguments shell; result proxies retain the result role/id too. Thus even `drop_mode=full` stays a pair. This is the principal defect, not a failed tag selection. Native replay (`native-replay-state-pi.ts:32-84`, `native-replay-pi.ts:88-117`) rewrites arguments only; native `function_call` items are never removed. A fix must remove complete pairs in both normalized content and native payload, preserve open arcs, and retain signed-reasoning safety separators.

## 2. Twelve historian messages does not establish a 2,500-message protected tail

The recorded trigger at 07:09:35 uses **90.6%**, not 188% (session log 616-619): ~26,103 eligible tokens, then chunk 39724–39735 (~450 rendered tokens). At 188% the historian is already in flight and no boundary is recomputed (684). The emergency transform latch is engaged (574,579), but historian scheduling re-reads piUsage, losing that bumped pressure. These are distinct pressure consumers.

The live-prompt floor clause is `protected-tail-boundary.ts:700-712`: only below the derived force band and without an emergency scale does the newest meaningful user ordinal constrain the boundary. At 188% it cannot pin the head. `636-673` fences open/complete arcs; `730-741` applies a separate head cap. Pi calls this shared resolver (`context-handler.ts:4406-4419`), so it carries the shared head-cap admission logic and has dedicated `issue-424.test.ts` coverage. The capture contains neither boundaryDiagnostics nor the raw ordinal stream used to resolve that historical chunk. Claiming one of these clauses was the exact historical pin from a wire item count alone would be unfounded. The pressure-latch loss is independently reproducible and fixed: the scheduler's minimum percentage now reaches the historian's shared pressure snapshot. No head-cap, live-prompt-floor, or completed-arc policy is weakened. `pi-historian-runner.ts:654-659` additionally applies historianChunkTokens to the eligible range: a chunk end is not necessarily protectedTailStart. The recovered session_meta scalar suffix records prior_boundary_ordinal=39736 and emergency_drain_active=0; this is the later recovered snapshot, not proof of the drain latch state at 07:09.

## 3. The emergency batch exhausted active visible candidates

At 07:11:37, log 661: 1,461 targets, 1,385 dropped rows replayed; log 668: 32,435 total rows, 2,223 active rows (all statuses/types/history are not interchangeable). Log 670: selected 36, reclaim 39,495 of 329,870, floor 0, ceiling 183,600. Target = 0.30 × 183,600 = 55,080; need = 384,950 − 55,080 = 329,870; remaining shortfall = 290,375. Selection did not stop at its goal.

Pi `heuristic-cleanup-pi.ts:353-358` filters to active tool targets whose canDrop succeeds. Shared `emergency-drop.ts:185-189,215-269` yields both protected window and T1/T2 reserve at >=95%, retaining newest three ctx_reduce exemplars. Already dropped skeletons are excluded from selection yet still occupy the wire because of defect 1. The 874k active-tool DB token total is not the visible candidate total. Exact per-tier, absent-target, and exemplar counts cannot be recovered from aggregate tags-by-status or final request bodies: no per-row tag snapshot was captured. Add explicit candidate diagnostics rather than inventing those counts. No evidence supports changing the >=95% selection policy.

## 4. Above-wall accounting must remain pressure (confirmed defect)

`pi-pressure.ts:108-115` discards finite positive samples above the trusted wall. `index.ts:645-655` logs and ignores them; the persisted-floor repair at 695-712 can also zero the display. The capture confirms 380,687 was ignored at 07:11:04. Retain the bounded provider sample: clamp numerator to 272,000, never enlarge model capacity from an impossible observation, persist denominator and pressure so the next pass does not depend on piUsage fallback. A clamped provider measurement is not proof that a request of that size succeeded. Preserve that distinction from observed-safe-input capacity inference. Status must derive percentages from a sane usable denominator, not divide by placeholder zero/one or reuse an inconsistent percentage.

## 5. Hygiene excludes surviving skeleton bytes (confirmed defect)

`context-handler.ts:3466-3474` measures the rendered stream after postprocess; `tail-hygiene-walk-pi.ts:705-718` refreshes on bust/first pass. Defer passes accumulate append-only deltas; changed prefixes invalidate until the next bust (721-731). More importantly, `collectToolArcs:321-326` marks an entire arc sentinel when its result is dropped, and `620-629` excludes its input too. A full-drop shell can therefore remain expensive on the wire while T collapses. U should exclude dropped/queued tags; T must count served tool input/output bytes, including surviving skeletons. The panel's Tool Calls/Conversation buckets use different accounting, so those totals cannot validate the hygiene denominator. The recovered panel is an operator observation, not present as a rendered panel in these captures.

## 6. Hints and acknowledgement

Pi `tools/ctx-reduce.ts:182-198` correctly filters dropped and pending tags but conflates them in acknowledgement. Name already-dropped and already-queued tags separately. Channel baseline snapshots must be taken after drops; hint readers must continue filtering pending and dropped tags. The shared SQL reader (`storage-tags.ts:323-329`) excludes dropped and queued tags at baseline creation. However, Pi `ctx-reduce-nudge-pi.ts:187,288` delivers cached oldestReclaimableToolTags without revalidation. Both channels reproducibly advertise a tag dropped/queued after their baseline. Delivery now intersects hints with current active rows and excludes current pending drops. A no-op acknowledgement alone still does not prove the historical nudge advertised the particular requested tags: an agent can reuse an older list. The capture records channel2 delivery but not a complete mapping from that delivered hint to the next requested tag set. Validate filtering with regression tests rather than assuming causal attribution.

## Recovery

The operator reports a later historian publication (623 → 624 compartments) reduced pressure to 141.6K / 204K. This confirms eventual folding, not absence of the skeleton/accounting defects. `/ctx-wrapup` remains operator relief; fixes must not depend on it.

## Implemented changes and verification contracts

- Complete full-drop arcs are removed together through an optional transcript structural-removal capability. Part indices remain stable until commit, and emptied messages are spliced only after positional stable-ID maps and history injection have run. Native Responses invocation items are removed with their generic calls; unrelated native items survive. Ambiguous/unknown native identity conservatively retains a pair. Open arcs remain active. Responses does not require Anthropic's signed-turn separator: the receiving Responses API explicitly disables that separator requirement without clearing reasoning itself. Anthropic/unknown receivers retain the existing reasoning-safe skeleton exception.
- A 25-arc fixture now serves exactly the newest 20 paired skeletons on both initial materialization and persisted replay. Tests capture the installed Pi SDK's Anthropic request before network I/O and invoke its Responses serializer, asserting actual tool_use/tool_result and function_call/function_call_output pairing and missing old IDs in serialized bytes. Native providerPayload removal is separately asserted, because the installed Pi 0.83 serializer does not implement OMP's newer native envelope.
- Above-wall positive finite usage clamps rather than disappears. The message_end log names raw tokens, wall, and `pressure_proof_not_capacity`. By parent decision this is pressure proof, NOT observed-safe capacity proof: existing valid observedSafeInputTokens is unchanged; poisoned older capacity state is cleared. Tests assert next scheduler execution, unchanged valid capacity proof, and no detected limit above the wall. One-token/invalid status denominators no longer manufacture enormous percentages.
- The historian receives the scheduler's recovery pressure floor, preventing the first post-restart emergency pass from reverting to 90.6% boundary admission. No changes to head-cap admission or the >=95% tier/reserve policy were justified. Candidate logs now include loaded/active/active-tool/visible-complete counts, cutoff, and whether the window yields.
- Hygiene T counts remaining skeleton input/output content; U excludes both sentinel arcs and durable dropped/queued tags. Existing reasoning/signature and synthetic-prefix exclusions remain deliberate policy, so T is a rendered tail-content measure, not total provider input including all envelopes/system/native signatures.
- Both delivery channels revalidate cached reclaim hint IDs against the current database. ctx_reduce acknowledgements distinguish already-dropped from already-queued IDs.

### Existing assertions intentionally changed

The former impossible-sample rejection/zero-usage assertions now require clamped pressure; this is the requested contract change. Full-drop replay assertions now require paired removal rather than sentinel shells. The same-owner dedup fixtures now include completed results: open invocations must not be consumed by dedup. The shared marathon fixture distinguishes Pi's active open-invocation tag from OpenCode's absent output tag while still asserting that the open call remains on the wire. Hygiene assertions no longer declare a visible dropped arc to have zero T or advertise a dropped durable row in U. Nudge copy fixtures seed the active tag rows they advertise so delivery-time validation checks real state rather than accepting fictitious hints.

### Evidence limitations

The captured requests and aggregate DB exports cannot reconstruct the exact historical protected-tail clause or per-tier tag candidate inventory. No raw ordinal transcript, per-row status snapshot, or boundaryDiagnostics for that successful historian invocation is supplied. The report deliberately distinguishes source-proven behavior and reproduced defects from those historical unknowns. It does not claim the pressure-latch correction alone explains the 12-message chunk, nor that every surviving arc was full-mode rather than frozen truncated-mode.

Native deletion honors the prior native-upgrade contract: a legacy full-drop row alone does not authorize changing native bytes on a defer pass. On a priced pass, removal records an explicit `__magic_context_remove_tool_arc__` marker in the existing durable native tool-input lane before removing either half. Replay requires that frozen marker; malformed native documents and failed writes retain the pair. The native-upgrade test now expects the authorized transition to remove `call-old`, rather than retain its shell, while all failure/defer/restart assertions remain intact.

## Final gate results

Pi full suite: 1,111 passed; the only failure was the existing memoized hygiene timing gate (16.243ms p95 vs 15ms). A focused retry measured 23.920ms; running the **unchanged base implementation** with the same test under current shared-machine load measured 131.390ms. Earlier functional runs measured 2.574ms. No timing threshold or test was relaxed. All functional tests, including native upgrade/failure/restart and both actual SDK wire serializers, passed in the final full run.

Pi lint passed with its pre-existing `piM0State!` warning; Pi typecheck and build passed. Shared-core typecheck and 38 targeted transcript/drop/marathon tests passed; changed shared files lint clean. AFT diagnostics were incomplete because its TypeScript server failed initialization and Biome/Astro producers were unavailable; CLI typechecks/lint were the authoritative gates. Frozen dependency installation completed without manifest or lockfile changes. Comment review found no flagged changed comments.

Three staged-and-restored non-vacuity controls independently made the named pressure-persistence, Responses wire-pair removal, and Channel-1 hint freshness regressions fail. The working diff was empty after each restore; no mutant was committed.
