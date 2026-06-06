import { describe, expect, it } from "bun:test";

import { blockedEmbeddingEndpointReason } from "./embedding-ssrf";

describe("blockedEmbeddingEndpointReason", () => {
    it("blocks the AWS/GCP/Azure metadata IP", () => {
        expect(blockedEmbeddingEndpointReason("http://169.254.169.254/latest")).toBeTruthy();
    });

    it("blocks any 169.254.0.0/16 link-local address", () => {
        expect(blockedEmbeddingEndpointReason("http://169.254.1.1:8080/v1")).toBeTruthy();
    });

    it("blocks metadata hostnames", () => {
        expect(blockedEmbeddingEndpointReason("http://metadata.google.internal/v1")).toBeTruthy();
        expect(blockedEmbeddingEndpointReason("http://METADATA.GOOGLE.INTERNAL/v1")).toBeTruthy();
    });

    it("blocks IPv6 link-local", () => {
        expect(blockedEmbeddingEndpointReason("http://[fe80::1]/v1")).toBeTruthy();
    });

    it("ALLOWS localhost / loopback (self-hosted LMStudio)", () => {
        expect(blockedEmbeddingEndpointReason("http://localhost:1234/v1")).toBeNull();
        expect(blockedEmbeddingEndpointReason("http://127.0.0.1:1234/v1")).toBeNull();
        expect(blockedEmbeddingEndpointReason("http://[::1]:1234/v1")).toBeNull();
    });

    it("ALLOWS private LAN ranges (Ollama on a GPU box)", () => {
        expect(blockedEmbeddingEndpointReason("http://192.168.1.50:11434/v1")).toBeNull();
        expect(blockedEmbeddingEndpointReason("http://10.0.0.5/v1")).toBeNull();
        expect(blockedEmbeddingEndpointReason("http://172.16.3.4/v1")).toBeNull();
    });

    it("ALLOWS public provider endpoints", () => {
        expect(blockedEmbeddingEndpointReason("https://api.openai.com/v1")).toBeNull();
        expect(blockedEmbeddingEndpointReason("https://integrate.api.nvidia.com/v1")).toBeNull();
    });

    it("blocks (fails closed) on an unparseable endpoint", () => {
        expect(blockedEmbeddingEndpointReason("not a url")).toBeTruthy();
    });

    it("treats empty endpoint as allowed (provider no-ops on empty)", () => {
        expect(blockedEmbeddingEndpointReason("")).toBeNull();
        expect(blockedEmbeddingEndpointReason("   ")).toBeNull();
    });
});
