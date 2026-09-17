# Transform mutation admission

Scheduler execute alone originates nothing. Queued agent drops and automatic
reclaim consume one per-pass permission: an executed history fold (including
first render), a published-history refresh landing, an explicit `/ctx-flush`,
an available force-band episode, emergency, or deferred publication consumed
late. Neither a pending-drop set nor a drain latch creates that permission.

Published work may drain while a historian is in flight: rendering summaries
and applying reductions do not change the historian's raw input. An executed
fold likewise drains queued work on that same pass; historian activity is not
a separate veto on the shared permission.

Force-band episodes retain their existing one-batch discipline. A batch queued
after consumption waits for another originating opportunity, including a later
fold or emergency; there is no age-based promotion. Already-applied mutations
continue to replay deterministically on defer passes.
