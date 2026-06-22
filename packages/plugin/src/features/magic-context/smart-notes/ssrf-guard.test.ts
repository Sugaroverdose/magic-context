import { describe, expect, test } from "bun:test";

import { type SmartNoteResolver, validateSmartNoteHttpUrl } from "./ssrf-guard";

const signal = new AbortController().signal;

function resolver(rows: Array<{ address: string; family: 4 | 6 }>): SmartNoteResolver {
    return { lookup: async () => rows };
}

describe("smart-note SSRF guard", () => {
    test("requires https", async () => {
        await expect(validateSmartNoteHttpUrl("http://example.com", { signal })).rejects.toThrow(
            /https/i,
        );
        await expect(validateSmartNoteHttpUrl("file:///etc/passwd", { signal })).rejects.toThrow();
    });

    test("blocks alternate IPv4 loopback encodings canonicalized by URL", async () => {
        for (const host of ["127.1", "0177.0.0.1", "0x7f.0.0.1", "2130706433"]) {
            await expect(validateSmartNoteHttpUrl(`https://${host}/`, { signal })).rejects.toThrow(
                /non-global|internal/i,
            );
        }
    });

    test("blocks private, link-local, metadata, CGNAT, multicast, and documentation IPv4", async () => {
        for (const address of [
            "10.0.0.1",
            "172.16.0.1",
            "192.168.0.1",
            "169.254.169.254",
            "169.254.1.10",
            "100.64.0.1",
            "224.0.0.1",
            "192.0.2.10",
            "198.51.100.10",
            "203.0.113.10",
        ]) {
            await expect(
                validateSmartNoteHttpUrl(`https://${address}/`, { signal }),
            ).rejects.toThrow(/non-global|internal/i);
        }
    });

    test("blocks IPv4-mapped and private IPv6 ranges", async () => {
        for (const host of [
            "[::1]",
            "[::ffff:127.0.0.1]",
            "[fe80::1]",
            "[fc00::1]",
            "[fd00:ec2::254]",
            "[ff02::1]",
            "[2001:db8::1]",
        ]) {
            await expect(validateSmartNoteHttpUrl(`https://${host}/`, { signal })).rejects.toThrow(
                /non-global|internal/i,
            );
        }
    });

    test("rejects DNS answers with any private address", async () => {
        await expect(
            validateSmartNoteHttpUrl("https://example.test/", {
                signal,
                resolver: resolver([
                    { address: "93.184.216.34", family: 4 },
                    { address: "10.0.0.2", family: 4 },
                ]),
            }),
        ).rejects.toThrow(/non-global|internal/i);
    });

    test("allows public DNS answers and preserves all validated candidates", async () => {
        const validated = await validateSmartNoteHttpUrl("https://example.test/path", {
            signal,
            resolver: resolver([
                { address: "93.184.216.34", family: 4 },
                { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
            ]),
        });
        expect(validated.addresses.map((a) => a.address)).toEqual([
            "93.184.216.34",
            "2606:2800:220:1:248:1893:25c8:1946",
        ]);
    });
});
