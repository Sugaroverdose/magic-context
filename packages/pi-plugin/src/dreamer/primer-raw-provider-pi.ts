import type { RawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import type { RawMessage } from "@magic-context/core/hooks/magic-context/read-session-raw";
import { convertEntriesToRawMessages } from "../read-session-pi";

/**
 * Pi `primerRawProviderFactory`: resolve a historical session id to a
 * `RawMessageProvider` over its JSONL, so refresh-primers can render the
 * orientation seed on Pi-only installs (no opencode.db).
 *
 * Discovery is async (listSessions / loadEntriesFromFile), so this returns a
 * Promise; the produced provider's `readMessages()` is synchronous (it wraps the
 * already-loaded RawMessage[]). Returns null when the session can't be resolved
 * or has no entries → refresh-primers falls back to closed-book for that primer.
 */
export interface PiPrimerRawProviderDeps {
	listSessions?: (sessionDir?: string) => unknown[] | Promise<unknown[]>;
	loadEntriesFromFile?: (filePath: string) => unknown[] | Promise<unknown[]>;
	sessionDir?: string;
}

const PI_CODING_AGENT_MODULE = "@earendil-works/pi-coding-agent";

interface PiSessionInfoLike {
	id?: unknown;
	path?: unknown;
}

export function createPiPrimerRawProviderFactory(
	deps: PiPrimerRawProviderDeps = {},
): (sessionId: string) => Promise<RawMessageProvider | null> {
	let resolved: Promise<
		Required<
			Pick<PiPrimerRawProviderDeps, "listSessions" | "loadEntriesFromFile">
		>
	> | null = null;

	const resolveDeps = async () => {
		if (deps.listSessions && deps.loadEntriesFromFile) {
			return {
				listSessions: deps.listSessions,
				loadEntriesFromFile: deps.loadEntriesFromFile,
			};
		}
		resolved ??= loadDefaultPiSessionDeps();
		return resolved;
	};

	return async (sessionId: string): Promise<RawMessageProvider | null> => {
		try {
			const { listSessions, loadEntriesFromFile } = await resolveDeps();
			const sessions = (await listSessions(
				deps.sessionDir,
			)) as PiSessionInfoLike[];
			const match = sessions.find(
				(s) =>
					s &&
					typeof s === "object" &&
					s.id === sessionId &&
					typeof s.path === "string",
			);
			if (!match || typeof match.path !== "string") return null;
			const entries = await loadEntriesFromFile(match.path);
			const messages = convertEntriesToRawMessages(entries);
			if (messages.length === 0) return null;
			return {
				readMessages(): RawMessage[] {
					return messages;
				},
				getMessageCount() {
					return messages.length;
				},
			};
		} catch {
			return null;
		}
	};
}

async function loadDefaultPiSessionDeps(): Promise<
	Required<
		Pick<PiPrimerRawProviderDeps, "listSessions" | "loadEntriesFromFile">
	>
> {
	const mod = (await import(/* @vite-ignore */ PI_CODING_AGENT_MODULE)) as {
		SessionManager?: {
			listSessions?: (sessionDir?: string) => unknown[] | Promise<unknown[]>;
		};
		loadEntriesFromFile?: (filePath: string) => unknown[] | Promise<unknown[]>;
	};
	const listSessions = mod.SessionManager?.listSessions;
	const loadEntriesFromFile = mod.loadEntriesFromFile;
	if (
		typeof listSessions !== "function" ||
		typeof loadEntriesFromFile !== "function"
	) {
		throw new Error(
			"Pi session APIs unavailable: expected SessionManager.listSessions and loadEntriesFromFile",
		);
	}
	return {
		listSessions: listSessions.bind(mod.SessionManager),
		loadEntriesFromFile,
	};
}
