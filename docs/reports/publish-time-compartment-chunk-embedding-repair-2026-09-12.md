# Publish-time compartment chunk embedding repair

Publish-time embedding now rejects an in-memory historian block when its ordinal span overlaps only part of a compartment and its text parts cannot be attributed one-to-one to ordinals. The publish helper then rebuilds canonical text from FTS for that compartment. Chunk windows also assert that parsed line ranges stay inside the owning compartment and use zero-based indices.

## Existing stores

No migration is needed. Pure coverage checks reconstruct each compartment from FTS, recognize an exact one-based key shift when every hash still matches, and count that set as embedded without writing. Once a backfill drain holds the project's write lease, its selector renumbers those rows transactionally in place, preserving vectors, hashes, and ordinal ranges without a provider call. A genuine hash or window mismatch remains `stale`, so the ordinary embedding drain re-embeds that compartment and atomically replaces its stored chunk rows.
