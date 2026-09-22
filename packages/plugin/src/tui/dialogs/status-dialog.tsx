/** @jsxImportSource @opentui/solid */
// @ts-nocheck
/**
 * The `/ctx-status` dialog: one view, drawn from the shared status model.
 *
 * It lives in its own module so both host generations can mount the same
 * component. OpenCode 1 imports it from here; OpenCode 2 loads the compiled
 * copy (`src/tui-compiled/dialogs/status-dialog.tsx`) through the host's
 * OpenTUI runtime registry and mounts it on its dialog surface, the same
 * arrangement `src/v2/tui/sidebar-mount.ts` uses for the sidebar.
 */
import { createMemo, createSignal, onCleanup } from "solid-js"
import type { TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import packageJson from "../../../package.json"
import { statusSummaryFromDetail } from "../../shared/status-summary"
import {
    buildStatusView,
    statusColumnsFor,
    type StatusRow,
    type StatusSection,
    type StatusTone,
    type StatusViewSource,
} from "../../shared/status-view"
import { RUST_MODE_HOST_PATHS_LINE } from "../../shared/rust-mode-status"
import type { StatusDetail } from "../data/context-db"

const R = (props: { t: TuiThemeCurrent; l: string; v: string; fg?: string }) => (
    <box width="100%" flexDirection="row" justifyContent="space-between">
        <text fg={props.t.textMuted}>{props.l}</text>
        <text fg={props.fg ?? props.t.text}>{props.v}</text>
    </box>
)

/**
 * Resolves a shared status tone against this host's theme. Every row in the
 * status dialog passes through here: a row drawn without an explicit colour
 * takes the terminal's default foreground, which on a light theme is the same
 * colour as the dialog background and reads as a blank page.
 */
function toneColor(theme: TuiThemeCurrent, tone: StatusTone): string {
    if (tone === "accent") return theme.accent
    if (tone === "muted") return theme.textMuted
    if (tone === "warning") return theme.warning
    if (tone === "error") return theme.error
    return theme.text
}

/**
 * Width the dialog is actually laid out at, which is NOT the terminal width:
 * each host sizes its own dialog surface (OpenCode 2's widest is 88 columns on
 * a 200-column terminal), and that is the width the sections have to fit into.
 * Renderables carry their laid-out width and emit "resized" when it changes, so
 * the component reads it from its own root box.
 *
 * Until the first layout there is no width to read; the terminal width is the
 * fallback, and an unknown terminal keeps the wide layout the dialog has always
 * drawn rather than collapsing on a guess.
 */
function terminalColumns(): number {
    const columns = process.stdout?.columns
    return typeof columns === "number" && columns > 0 ? columns : Number.POSITIVE_INFINITY
}

/** One label/value row, with the label column fixed so labels never wrap mid-word. */
const StatusRowView = (props: { t: TuiThemeCurrent; row: StatusRow; labelWidth: number }) => (
    <box width="100%" flexDirection="row" justifyContent="space-between" gap={1}>
        <box width={props.labelWidth} flexShrink={0}>
            <text fg={props.t.textMuted}>{props.row.label}</text>
        </box>
        <text fg={toneColor(props.t, props.row.tone)}>{props.row.value}</text>
    </box>
)

const StatusSectionView = (props: { t: TuiThemeCurrent; section: StatusSection }) => (
    <box flexDirection="column" width="100%" marginTop={1}>
        <text fg={props.t.text}>
            <b>{props.section.title}</b>
        </text>
        {props.section.rows.map((row) => (
            <StatusRowView t={props.t} row={row} labelWidth={props.section.labelWidth} />
        ))}
    </box>
)

export const StatusDialog = (props: { api: TuiPluginApi; s: StatusDetail }) => {
    const theme = createMemo(() => (props.api as any).theme.current)
    const t = () => theme()
    const s = () => props.s
    const compactionOff = () => s().compaction_enabled === false

    // Prefer the RPC-provided model context limit (what the sidebar shows) so the
    // two surfaces never disagree. Fall back to deriving from usage% only when the
    // RPC limit is absent (0) — and that derivation is itself undefined at 0%, so
    // it stays "?" rather than showing a number inconsistent with the sidebar.
    const contextLimit = () =>
        s().contextLimit > 0
            ? s().contextLimit
            : s().usagePercentage > 0
              ? Math.round(s().inputTokens / (s().usagePercentage / 100))
              : 0

    // Which rows exist, what they are called and which colour they carry is
    // decided by the shared model, so this dialog and Pi's overlay cannot drift
    // apart. This component only draws what the model returns.
    const view = createMemo(() =>
        buildStatusView(
            {
                ...(s() as unknown as StatusViewSource),
                contextLimit: contextLimit(),
                warnings: statusSummaryFromDetail(s()).warnings,
            },
            { version: packageJson.version },
        ),
    )
    // The dialog's own laid-out width, which is what the sections have to fit
    // into; the terminal width is only the pre-layout fallback.
    const [dialogWidth, setDialogWidth] = createSignal(0)
    const measureRoot = (element: any) => {
        const read = () => {
            const width = Number(element?.width)
            if (Number.isFinite(width) && width > 0) setDialogWidth(width)
        }
        read()
        element?.on?.("resized", read)
        onCleanup(() => element?.off?.("resized", read))
    }
    // paddingLeft + paddingRight below; what the sections get is what is left.
    const contentWidth = () => (dialogWidth() > 0 ? dialogWidth() - 4 : terminalColumns())
    // The shared model decides whether the sections fit in two columns at this
    // width, and how wide each column has to be; below that the same sections
    // are drawn in one column, in the same order, instead of being squeezed
    // into mid-word wraps.
    const columns = () => statusColumnsFor(view().sections, contentWidth())
    const columnSections = (parity: number) =>
        view().sections.filter((_section, index) => index % 2 === parity)
    const hygiene = () => view().hygiene

    return (
        <box ref={measureRoot} flexDirection="column" width="100%" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
            {/* Title */}
            <box justifyContent="center" width="100%" marginBottom={1} flexDirection="row" gap={2}>
                <text fg={t().accent}><b>{view().title}</b></text>
                <text fg={t().textMuted}>{view().version}</text>
            </box>

            <box flexDirection="row" justifyContent="space-between" width="100%">
                <text fg={toneColor(t(), view().headline.left.tone)}>
                    <b>{view().headline.left.text}</b>
                </text>
                <text fg={toneColor(t(), view().headline.right.tone)}>
                    {view().headline.right.text}
                </text>
            </box>
            {view().windowLine && <text fg={t().textMuted}>{view().windowLine}</text>}

            {/* Segmented breakdown bar: a flex row of colored boxes filling the
                dialog width. Each segment grows with its token count, so opentui
                distributes the full width proportionally whatever the dialog's
                rendered width turns out to be. */}
            <box width="100%" flexDirection="row" height={1}>
                {view().bar.map((seg) => (
                    <box
                        key={seg.label}
                        flexGrow={Math.max(1, seg.tokens)}
                        flexBasis={0}
                        height={1}
                        backgroundColor={seg.color}
                    />
                ))}
            </box>

            {/* Breakdown legend */}
            <box flexDirection="column" width="100%">
                {view().breakdown.map((row) => (
                    <box key={row.label} width="100%" flexDirection="row" justifyContent="space-between" gap={1}>
                        <text fg={row.color}>{row.label}</text>
                        <text fg={t().textMuted}>{row.value}</text>
                    </box>
                ))}
                {hygiene() && (
                    <StatusRowView t={t()} row={hygiene()} labelWidth={9} />
                )}
            </box>

            {/* Recomp live progress (full width, only while
                running or just finished — dogfood 2026-05-30). This is live run
                state rather than status content, so it stays out of the shared
                section model. */}
            {!compactionOff() && s().recompProgress && (() => {
                const p = s().recompProgress!
                // Label follows the flow that started the run, so a plain
                // /ctx-recomp never reads as an "Upgrade" (dogfood 2026-06-04).
                const verb = p.kind === "upgrade" ? "Upgrade" : p.kind === "embed" ? "Embed" : "Recomp"
                return (
                <box marginTop={1} width="100%" flexDirection="column">
                    <text fg={t().text}><b>{verb}</b></text>
                    {(() => {
                        if (p.phase === "recomp") {
                            const frac = p.totalMessages > 0 ? p.processedMessages / p.totalMessages : 0
                            const width = 24
                            const filled = Math.round(Math.max(0, Math.min(1, frac)) * width)
                            const bar = p.totalMessages > 0
                                ? `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`
                                : "(starting…)"
                            const activeLabel = p.kind === "upgrade" ? "upgrading" : p.kind === "embed" ? "embedding" : "comparting"
                            return (
                                <>
                                    <R t={t()} l={activeLabel} v={p.totalMessages > 0 ? `${bar} ${Math.round(frac * 100)}%` : bar} fg={t().warning} />
                                    {p.note ? <R t={t()} l="Status" v={p.note} fg={t().textMuted} /> : null}
                                    {p.kind === "embed"
                                        ? <R t={t()} l="Compartments" v={`${p.processedMessages}/${p.totalMessages} embedded`} fg={t().textMuted} />
                                        : <R t={t()} l="Compartments" v={`${p.compartmentsCreated} (${p.passCount} pass${p.passCount === 1 ? "" : "es"})`} fg={t().textMuted} />}
                                </>
                            )
                        }
                        if (p.phase === "migration") return <R t={t()} l="Status" v={p.note ?? "Migrating memories ⟳"} fg={t().warning} />
                        if (p.phase === "done") return <R t={t()} l="Status" v={`✓ ${verb} complete`} fg={t().accent} />
                        if (p.phase === "skipped") return <R t={t()} l="Status" v={p.message ?? `${verb} stopped early`} fg={t().textMuted} />
                        return <R t={t()} l="Status" v={`✗ ${verb} failed${p.message ? `: ${p.message}` : ""}`} fg={t().error} />
                    })()}
                </box>
                )
            })()}

            {s().hostBackendsModuleSide && (
                <box marginTop={1} width="100%" flexDirection="column">
                    <text fg={t().text}><b>Rust Mode</b></text>
                    <text fg={t().textMuted}>{RUST_MODE_HOST_PATHS_LINE}</text>
                </box>
            )}

            {columns().twoColumn ? (
                <box flexDirection="row" width="100%" gap={4}>
                    <box flexDirection="column" width={columns().leftWidth} flexShrink={0}>
                        {columnSections(0).map((section) => (
                            <StatusSectionView t={t()} section={section} />
                        ))}
                    </box>
                    <box flexDirection="column" width={columns().rightWidth} flexShrink={0}>
                        {columnSections(1).map((section) => (
                            <StatusSectionView t={t()} section={section} />
                        ))}
                    </box>
                </box>
            ) : (
                <box flexDirection="column" width="100%">
                    {view().sections.map((section) => (
                        <StatusSectionView t={t()} section={section} />
                    ))}
                </box>
            )}

            {view().warnings.length > 0 && (
                <box marginTop={1} width="100%" flexDirection="column">
                    {view().warnings.map((warning) => (
                        <text fg={warning.tone === "error" ? t().error : t().warning}>{warning.text}</text>
                    ))}
                </box>
            )}

            {/* Footer */}
            <box marginTop={1} justifyContent="flex-end" width="100%">
                <text fg={t().textMuted}>{view().footer}</text>
            </box>
        </box>
    )
}

