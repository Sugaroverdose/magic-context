import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverHostService, removeHostSession, serviceRegistrationPath } from "./host-service";

function stateHome(registration?: unknown): { env: NodeJS.ProcessEnv; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), "mc-host-service-"));
    const env = { XDG_STATE_HOME: root } as NodeJS.ProcessEnv;
    if (registration !== undefined) {
        mkdirSync(join(root, "opencode"), { recursive: true });
        writeFileSync(
            serviceRegistrationPath(env),
            typeof registration === "string" ? registration : JSON.stringify(registration),
        );
    }
    return { env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

interface Seen {
    method: string;
    path: string;
    authorization: string | null;
}

async function withStub(status: number, body: (url: string) => Promise<void>): Promise<Seen[]> {
    const seen: Seen[] = [];
    const server = Bun.serve({
        port: 0,
        fetch(request) {
            const url = new URL(request.url);
            seen.push({
                method: request.method,
                path: url.pathname,
                authorization: request.headers.get("authorization"),
            });
            return new Response(null, { status });
        },
    });
    try {
        await body(`http://127.0.0.1:${server.port}`);
    } finally {
        server.stop(true);
    }
    return seen;
}

describe("OpenCode 2 host service discovery", () => {
    test("reports nothing when no service registered itself", () => {
        const { env, cleanup } = stateHome();
        try {
            expect(discoverHostService(env)).toBeUndefined();
        } finally {
            cleanup();
        }
    });

    test("ignores a registration that is unreadable or has no url", () => {
        for (const registration of ["{ not json", {}, { url: "" }, { password: "secret" }]) {
            const { env, cleanup } = stateHome(registration);
            try {
                expect(discoverHostService(env)).toBeUndefined();
            } finally {
                cleanup();
            }
        }
    });

    test("turns a registration into a base url and basic auth for the opencode user", () => {
        const { env, cleanup } = stateHome({
            id: "service-1",
            version: "2.0.5",
            url: "http://127.0.0.1:4096/",
            pid: 42,
            password: "s3cret",
        });
        try {
            expect(discoverHostService(env)).toEqual({
                url: "http://127.0.0.1:4096",
                headers: {
                    authorization: `Basic ${Buffer.from("opencode:s3cret", "utf8").toString("base64")}`,
                },
            });
        } finally {
            cleanup();
        }
    });

    test("an unauthenticated service registration sends no authorization header", () => {
        const { env, cleanup } = stateHome({ url: "http://127.0.0.1:4096", pid: 42 });
        try {
            expect(discoverHostService(env)?.headers).toEqual({});
        } finally {
            cleanup();
        }
    });
});

describe("OpenCode 2 host session removal", () => {
    test("deletes through the host's session route with the registration's credentials", async () => {
        const seen = await withStub(204, async (url) => {
            const { env, cleanup } = stateHome({ url, pid: 1, password: "s3cret" });
            try {
                await removeHostSession("ses_abc/1", env);
            } finally {
                cleanup();
            }
        });
        expect(seen).toEqual([
            {
                method: "DELETE",
                path: "/api/session/ses_abc%2F1",
                authorization: `Basic ${Buffer.from("opencode:s3cret", "utf8").toString("base64")}`,
            },
        ]);
    });

    test("treats an already-deleted session as done", async () => {
        await withStub(404, async (url) => {
            const { env, cleanup } = stateHome({ url, pid: 1 });
            try {
                await expect(removeHostSession("ses_gone", env)).resolves.toBeUndefined();
            } finally {
                cleanup();
            }
        });
    });

    test("reports a refusal so the caller can leave the entry for a later sweep", async () => {
        await withStub(401, async (url) => {
            const { env, cleanup } = stateHome({ url, pid: 1 });
            try {
                await expect(removeHostSession("ses_abc", env)).rejects.toThrow("401");
            } finally {
                cleanup();
            }
        });
    });

    test("reports that no service is registered rather than silently doing nothing", async () => {
        const { env, cleanup } = stateHome();
        try {
            await expect(removeHostSession("ses_abc", env)).rejects.toThrow(
                "No running OpenCode service is registered",
            );
        } finally {
            cleanup();
        }
    });
});
