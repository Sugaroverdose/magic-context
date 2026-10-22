// Canonical full-drop wire fragments, pinned layer-by-layer by
// overwall-wire-shapes.test.ts (the shape canonical). FPE tokens are
// session-keyed, so a released pair can never be pinned as a literal; these
// fragments pin the rendered shape. Where a case mixes a byte-pinned
// expectation with non-drop logic, swap the inline fixture for
// `expect(JSON.stringify(wire)).toContain(GOLDEN_...)`.

// Copy-source seat: the released args render as a single string seat key
// carrying the opaque token (canonical fixture seat: "path").
export const GOLDEN_FULL_DROP_CARRIER = '{"path":"';

// Released result slot: the constant `...` placeholder as JSON-rendered.
export const GOLDEN_FULL_DROP_OUTPUT = '"..."';
