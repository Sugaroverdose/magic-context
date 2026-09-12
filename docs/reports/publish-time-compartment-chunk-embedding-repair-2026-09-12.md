# Publish-time compartment chunk embedding repair

Publish-time embedding now rejects an in-memory historian block when its ordinal span overlaps only part of a compartment and its text parts cannot be attributed one-to-one to ordinals. The publish helper then rebuilds canonical text from FTS for that compartment. Chunk windows also assert that parsed line ranges stay inside the owning compartment and use zero-based indices.

## Existing stores

No migration is needed. The chunk coverage selector reconstructs each compartment from FTS and classifies rows with unexpected window indices or mismatched hashes as `stale`. The ordinary embedding drain re-embeds that compartment and atomically replaces its stored chunk rows.
