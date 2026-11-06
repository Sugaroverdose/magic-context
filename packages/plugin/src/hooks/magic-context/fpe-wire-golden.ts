// Canonical full-drop wire fragments, pinned layer-by-layer by
// tool-release-shapes.test.ts (the shape table, driven through the real
// createToolDropTarget.drop() / applyFlushedStatuses / tool.execute.before
// resolver — recaptured on the v2 production entry, dual-run byte equality).
// FPE tokens are session-keyed, so a released pair can never be pinned as a
// literal; these fragments pin the rendered SHAPE. Where a case mixes a
// byte-pinned expectation with non-drop logic, swap the inline fixture for
// `expect(JSON.stringify(wire)).toContain(GOLDEN_...)`.

// Copy-source seat: the released args render as a single string seat key
// carrying the opaque token (canonical fixture seat: "command").
export const GOLDEN_FULL_DROP_CARRIER = '{"command":"';

// Released result slot: the empty placeholder as JSON-rendered, per layer.
// (The old constant `...` was key-agnostic; empty content is identified by
// the slot's key, so the plugin layer pins `output` and the v2 payload layer
// pins the `text` result wrapper.)
export const GOLDEN_FULL_DROP_OUTPUT = '"output":""';
export const GOLDEN_V2_DROP_RESULT = '{"type":"text","value":""}';

// Pi lane (drop-shape doctrine restore, 2026-11-06): the Pi transcript adapter
// renders the copy-source seat from the fixture input (canonical Pi fixture
// seat: "path") and the released slot as a Pi text part. Ported from the base
// pi-side module (9c1520810:packages/pi-plugin/src/fpe-wire-golden.ts:14,:18,
// deleted from the v2 tree) — the fragments are re-expressed here against the
// v2-side registry rather than resurrecting the pi-side copy; shapes verified
// against the restored-carrier wire in transcript-pi.test.ts.
export const GOLDEN_PI_DROP_CARRIER = '{"path":"';
export const GOLDEN_PI_DROP_OUTPUT = '{"type":"text","text":""}';
