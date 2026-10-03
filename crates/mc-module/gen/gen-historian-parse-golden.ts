/**
 * Generate the historian OUTPUT PARSER parity golden for the Rust mc-module port.
 *
 * Drives the real TypeScript `parseCompartmentOutput` from packages/plugin and records
 * its result, normalized to the Rust field names, for each raw historian output below.
 * `historian_validate::tests::parse_golden_matches_typescript_parser` asserts that
 * `parse_compartment_output` produces exactly the same structure, so any parsing rule
 * changed on one side must be changed on the other.
 *
 * Every case is a single complete `<output>` document: the Rust parser additionally
 * rejects outputs without one root, which the TypeScript parser does not check.
 * Side-channel anchor prefixes (`[at_compartment=N] fact`) are Rust-only and are kept
 * out of these cases.
 *
 * Run: bun crates/mc-module/gen/gen-historian-parse-golden.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const pluginDir = join(import.meta.dir, "..", "..", "..", "packages", "plugin");
const parserMod = await import(
    Bun.resolveSync("./src/hooks/magic-context/compartment-parser", pluginDir)
);
const { parseCompartmentOutput } = parserMod as {
    parseCompartmentOutput: (text: string) => ParsedTs;
};

interface ParsedTs {
    compartments: Array<Record<string, unknown>>;
    facts: Array<{ category: string; content: string }>;
    droppedFactBlocks: number;
    droppedFacts: number;
    events: Array<{ kind: string; atCompartment: number | null; fields: Record<string, string> }>;
    unprocessedFrom: number | null;
    userObservations: string[];
    primerCandidates: Array<{ question: string; originCompartmentIndex?: number }>;
}

function asNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}

function normalize(parsed: ParsedTs) {
    return {
        compartments: parsed.compartments.map((c) => ({
            start_message: Number(c.startMessage),
            end_message: Number(c.endMessage),
            title: String(c.title ?? ""),
            content: String(c.content ?? ""),
            p1: asString(c.p1),
            p2: asString(c.p2),
            p3: asString(c.p3),
            p4: asString(c.p4),
            importance: asNumber(c.importance),
            episode_type: asString(c.episodeType),
        })),
        facts: parsed.facts.map((f) => ({
            category: f.category,
            content: f.content,
            origin_compartment_index: null,
        })),
        dropped_fact_blocks: parsed.droppedFactBlocks,
        dropped_facts: parsed.droppedFacts,
        events: parsed.events.map((e) => ({
            kind: e.kind,
            at_compartment: e.atCompartment,
            fields: Object.fromEntries(
                Object.keys(e.fields)
                    .sort()
                    .map((key) => [key, e.fields[key]]),
            ),
        })),
        unprocessed_from: parsed.unprocessedFrom,
        user_observations: parsed.userObservations.map((content) => ({
            content,
            origin_compartment_index: null,
        })),
        primer_candidates: parsed.primerCandidates.map((p) => ({
            question: p.question,
            origin_compartment_index: asNumber(p.originCompartmentIndex),
        })),
    };
}

function tiers(p1: string): string {
    return `<p1>${p1}</p1>\n<p2>${p1} short</p2>\n<p3>${p1} shorter</p3>\n<p4/>`;
}

interface CaseSpec {
    label: string;
    text: string;
}

const cases: CaseSpec[] = [
    {
        label: "well-formed tiers, facts and side channels",
        text: `<output>
<compartments>
<compartment start="1" end="2" title="Setup" episode_type="infra" importance="40">
${tiers("did setup")}
</compartment>
</compartments>
<facts>
<PROJECT_RULES>
* Keep goldens deterministic.
</PROJECT_RULES>
</facts>
<events><causal_incident at_compartment="1"><summary>Setup broke.</summary></causal_incident></events>
<user_observations>
* Prefers short answers.
</user_observations>
<primer_candidates><primer at_compartment="1">How is setup done?</primer></primer_candidates>
<meta><unprocessed_from>3</unprocessed_from></meta>
</output>`,
    },
    {
        label: "mismatched and missing tier closes stay lenient",
        text: `<output><compartments>
<compartment start="1" end="2" title="mismatch"><p1>first</p2><p2>second</p1><p3>third</p3><p4 /></compartment>
<compartment start="3" end="4" title="missing"><p1>first body<p2>second body</p2><p3>third</p3><p4/></compartment>
<compartment start="5" end="6" title="overcapture"><p1>alpha<p2>beta</p1><p3>gamma</p3><p4/></compartment>
<compartment start="7" end="8" title="flat">just flat content</compartment>
</compartments></output>`,
    },
    {
        label: "xml entities decode exactly once",
        text: `<output><compartments>
<compartment start="1" end="2" title="A &amp;lt; B &quot;q&quot;" episode_type="x&amp;amp;y">
${tiers("Use &amp;lt; entity &amp;amp; &lt;tag&gt; &apos;s &amp;gt;")}
</compartment>
<compartment start="3" end="4" title="flat">Flat &amp;quot; body &amp; more</compartment>
</compartments>
<facts>
<ARCHITECTURE>
* Escape with &amp;amp; before &amp;lt;.
</ARCHITECTURE>
</facts>
<events><causal_incident at_compartment="1"><summary>Saw &amp;lt;p1&amp;gt; literally</summary></causal_incident></events>
<user_observations>
* Writes &amp;apos; often.
</user_observations>
<primer_candidates><primer at_compartment="1">What is &amp;quot;?</primer></primer_candidates>
</output>`,
    },
];

const golden = cases.map((spec) => ({
    label: spec.label,
    text: spec.text,
    parsed: normalize(parseCompartmentOutput(spec.text)),
}));

const outPath = join(import.meta.dir, "..", "testdata", "historian-parse-golden.json");
writeFileSync(outPath, `${JSON.stringify(golden, null, 2)}\n`);
// eslint-disable-next-line no-console
console.log(`wrote ${golden.length} historian parse cases → ${outPath}`);
