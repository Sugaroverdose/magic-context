import { describe, expect, it } from "bun:test";
import { parse } from "comment-json";
import { parseJsonc } from "../../lib/jsonc";
import { structuredConfigSaveContent } from "./structured-save";

const commentedConfig = `{
  // keep this file under dotfiles
  "enabled": true,
  "embedding": {
    /* provider notes */
    "provider": "openai-compatible",
    "api_key": "{env:EMBED_KEY}" // never commit the key
  },
  "protected_tokens": 20000,
  "language": "en",
  // unknown keys stay
  "custom": [1, /* two */ 2]
}
`;

describe("structured config form save", () => {
  it("#given a commented config #when one form field changes #then every comment survives", () => {
    const form = structuredClone(parseJsonc(commentedConfig));
    form.protected_tokens = 30000;
    (form.embedding as Record<string, unknown>).model = "text-embedding-3-small";

    const saved = structuredConfigSaveContent(commentedConfig, form);

    expect(saved).toContain("// keep this file under dotfiles");
    expect(saved).toContain("/* provider notes */");
    expect(saved).toContain("// never commit the key");
    expect(saved).toContain("// unknown keys stay");
    expect(saved).toContain("/* two */");
    const parsed = parse(saved) as Record<string, unknown>;
    expect(parsed.protected_tokens).toBe(30000);
    expect(parsed.embedding).toEqual({
      provider: "openai-compatible",
      api_key: "{env:EMBED_KEY}",
      model: "text-embedding-3-small",
    });
  });

  it("#given a field cleared in the form #when saving #then the key is removed like before", () => {
    const form = structuredClone(parseJsonc(commentedConfig));
    form.language = undefined;

    const parsed = parse(structuredConfigSaveContent(commentedConfig, form)) as Record<
      string,
      unknown
    >;

    expect("language" in parsed).toBe(false);
    expect(parsed.enabled).toBe(true);
  });

  it("#given form data that omits a section's sub-keys #when saving #then those sub-keys are kept", () => {
    const form = structuredClone(parseJsonc(commentedConfig));
    form.embedding = { provider: "local" };

    const parsed = parse(structuredConfigSaveContent(commentedConfig, form)) as Record<
      string,
      unknown
    >;

    expect(parsed.embedding).toEqual({ provider: "local", api_key: "{env:EMBED_KEY}" });
  });

  it("#given no existing file #when saving #then a fresh config is written", () => {
    const parsed = parse(structuredConfigSaveContent("", { enabled: false })) as Record<
      string,
      unknown
    >;
    expect(parsed).toEqual({ enabled: false });
  });
});
