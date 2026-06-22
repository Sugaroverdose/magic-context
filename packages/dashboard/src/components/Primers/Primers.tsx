import { createResource, For, Show } from "solid-js";
import { getPrimers } from "../../lib/api";
import type { Primer } from "../../lib/types";

function formatDate(ms: number | null): string {
  if (!ms) return "never";
  return new Date(ms).toLocaleDateString();
}

function PrimerCard(props: { primer: Primer }) {
  return (
    <article class="memory-card">
      <div class="memory-card-header">
        <div>
          <div class="memory-content">
            <strong>{props.primer.question}</strong>
          </div>
          <div class="memory-meta">
            support {props.primer.total_support} · last observed{" "}
            {formatDate(props.primer.last_observed_at)} · refreshed{" "}
            {formatDate(props.primer.answer_refreshed_at)}
          </div>
        </div>
        <span class={`status-badge ${props.primer.status}`}>{props.primer.status}</span>
      </div>
      <div class="memory-content" style={{ "margin-top": "12px", "white-space": "pre-wrap" }}>
        {props.primer.answer || "Answer not synthesized yet."}
      </div>
    </article>
  );
}

export default function Primers() {
  const [primers] = createResource(() => getPrimers());

  return (
    <div class="page">
      <div class="page-header">
        <div>
          <h1>Primers</h1>
          <p class="muted">Durable standing questions about how this project works.</p>
        </div>
      </div>

      <Show when={!primers.loading} fallback={<div class="loading">Loading primers…</div>}>
        <Show
          when={(primers() ?? []).length > 0}
          fallback={<div class="empty-state">No primers promoted yet.</div>}
        >
          <div class="memory-list">
            <For each={primers() ?? []}>{(primer) => <PrimerCard primer={primer} />}</For>
          </div>
        </Show>
      </Show>
    </div>
  );
}
