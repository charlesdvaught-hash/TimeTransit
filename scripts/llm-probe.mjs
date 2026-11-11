#!/usr/bin/env node
// STAGE-0: fires canned queries at both LLM providers using the same
// payloads worker/transit-relay.js sends. No deps; Node 18+.
//   GROQ_API_KEY=... GEMINI_API_KEY=... node scripts/llm-probe.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROMPT =
  "You are the query preprocessor for a transit trip planner. " +
  "Split the user query into high_priority_anchors (specific named " +
  "places/brands that must anchor the route, normalized to canonical " +
  "name) and flexible_categories (generic venue categories, lowercase " +
  "OSM/Overture-style kinds like 'coffee shop'). Max 4 total stops. " +
  "If nothing parseable, return empty arrays.";
const SCHEMA = {
  type: "object",
  properties: {
    original_query: { type: "string" },
    high_priority_anchors: {
      type: "array",
      items: {
        type: "object",
        properties: {
          raw_term: { type: "string" },
          normalized_entity_name: { type: "string" },
        },
        required: ["raw_term", "normalized_entity_name"],
        additionalProperties: false,
      },
    },
    flexible_categories: { type: "array", items: { type: "string" } },
  },
  required: ["original_query", "high_priority_anchors", "flexible_categories"],
  additionalProperties: false,
};

// Gemini accepts an OpenAPI-3.0 subset — mirror the worker transform.
function geminiSchema(node) {
  if (Array.isArray(node)) return node.map(geminiSchema);
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "additionalProperties") continue;
    if (k === "type" && Array.isArray(v)) {
      out.type = v.filter((t) => t !== "null")[0] || "string";
    } else if (k === "enum" && Array.isArray(v)) {
      out.enum = v.filter((e) => e !== null);
    } else out[k] = geminiSchema(v);
  }
  return out;
}

// SemanticParseResult validator — same checks the relay callers rely on.
function valid(v) {
  return (
    !!v &&
    typeof v === "object" &&
    typeof v.original_query === "string" &&
    Array.isArray(v.high_priority_anchors) &&
    Array.isArray(v.flexible_categories) &&
    v.high_priority_anchors.length + v.flexible_categories.length <= 4 &&
    v.high_priority_anchors.every(
      (a) =>
        a &&
        typeof a.raw_term === "string" &&
        typeof a.normalized_entity_name === "string",
    ) &&
    v.flexible_categories.every((c) => typeof c === "string")
  );
}

// anchors/cats: array of alternative groups — a group counts as found when
// ANY member appears (substring, case-insensitive) in the result.
const QUERIES = [
  { q: "coffee", anchors: [], cats: [["coffee", "cafe"]] },
  { q: "walmart", anchors: [["walmart"]], cats: [] },
  { q: "starbucks", anchors: [["starbucks"]], cats: [] },
  { q: "target", anchors: [["target"]], cats: [] },
  { q: "pharmacy", anchors: [], cats: [["pharmacy", "drugstore"]] },
  { q: "in-n-out burger", anchors: [["in-n-out", "in n out"]], cats: [] },
  { q: "gas station", anchors: [], cats: [["gas", "fuel"]] },
  { q: "dmv", anchors: [["dmv"]], cats: [] },
  {
    q: "partners credit union then coffee and groceries",
    anchors: [["partners"]],
    cats: [
      ["coffee", "cafe"],
      ["grocer", "supermarket"],
    ],
  },
  {
    q: "walmert then tacob bell",
    anchors: [["walmart"], ["taco bell"]],
    cats: [],
  },
  {
    q: "coffee then groceries then gym then pharmacy then target",
    anchors: [["target"]],
    cats: [["coffee", "cafe"]],
  },
  { q: "asdfjkl", anchors: [], cats: [], expectEmpty: true },
  {
    q: "the park near the beach for sunset then somewhere cheap to eat",
    anchors: [],
    cats: [["park"], ["restaurant", "food", "eat", "diner", "fast food"]],
  },
  {
    q: "trader joes then a bike shop",
    anchors: [["trader joe"]],
    cats: [["bike", "bicycle", "cycle"]],
  },
  {
    q: "pick up my prescription then drop a package at the ups store",
    anchors: [["ups"]],
    cats: [["pharmacy", "drugstore", "prescription"]],
  },
  {
    q: "costco gas then home depot",
    anchors: [["costco"], ["home depot"]],
    cats: [],
  },
  {
    q: "sushi for lunch then boba",
    anchors: [],
    cats: [
      ["sushi", "japanese"],
      ["boba", "bubble tea", "tea"],
    ],
  },
  {
    q: "the library then somewhere to print a resume",
    anchors: [],
    cats: [["library"], ["print", "copy", "office supply", "staples"]],
  },
  {
    q: "farmers market then brunch",
    anchors: [],
    cats: [
      ["farmers market", "market"],
      ["brunch", "restaurant", "breakfast", "cafe"],
    ],
  },
  {
    q: "ikea then cheap tacos",
    anchors: [["ikea"]],
    cats: [["taco", "mexican", "restaurant"]],
  },
];

async function groq(key, input) {
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-20b",
      messages: [
        { role: "system", content: PROMPT },
        { role: "user", content: input },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "semantic_parse", strict: true, schema: SCHEMA },
      },
      reasoning_effort: "low",
      include_reasoning: false,
      temperature: 1,
      top_p: 1,
      max_completion_tokens: 1024,
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error(`groq ${r.status}`);
  const data = await r.json();
  return JSON.parse(data.choices[0].message.content);
}

async function gemini(key, input) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: PROMPT }] },
        contents: [{ role: "user", parts: [{ text: input }] }],
        generationConfig: {
          response_mime_type: "application/json",
          response_json_schema: geminiSchema(SCHEMA),
          thinkingConfig: { thinking_level: "minimal" },
        },
      }),
      signal: AbortSignal.timeout(60000),
    },
  );
  if (!r.ok) throw new Error(`gemini ${r.status}`);
  const data = await r.json();
  return JSON.parse(data.candidates[0].content.parts[0].text);
}

function score(parsed, expected) {
  if (expected.expectEmpty)
    return !parsed.high_priority_anchors.length &&
      !parsed.flexible_categories.length
      ? 1
      : 0;
  const anchors = parsed.high_priority_anchors
    .map((a) => a.normalized_entity_name)
    .join(" ")
    .toLowerCase();
  const cats = parsed.flexible_categories.join(" ").toLowerCase();
  const groups = [
    ...expected.anchors.map((g) => [g, anchors]),
    ...expected.cats.map((g) => [g, cats]),
  ];
  if (!groups.length) return null;
  const hits = groups.filter(([alts, hay]) =>
    alts.some((a) => hay.includes(a)),
  ).length;
  return hits / groups.length;
}

const keys = {
  groq: process.env.GROQ_API_KEY,
  gemini: process.env.GEMINI_API_KEY,
};
const missing = Object.entries(keys)
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length)
  console.log(`Missing keys, skipping: ${missing.join(", ")}`);
const providers = Object.entries({
  groq: ["GROQ_API_KEY", groq],
  gemini: ["GEMINI_API_KEY", gemini],
}).filter(([name]) => keys[name]);
if (!providers.length) {
  console.log("No provider keys set — nothing to do.");
  process.exit(0);
}

const out = { ran_at: new Date().toISOString(), providers: {} };
for (const [name, [, call]] of providers) {
  out.providers[name] = { rows: [] };
  for (const expected of QUERIES) {
    const row = { query: expected.q };
    const t0 = Date.now();
    try {
      const parsed = await call(keys[name], expected.q);
      row.latency_ms = Date.now() - t0;
      row.valid = valid(parsed);
      row.accuracy = row.valid ? score(parsed, expected) : 0;
      row.result = parsed;
    } catch (e) {
      row.latency_ms = Date.now() - t0;
      row.valid = false;
      row.accuracy = 0;
      row.error = e.message;
    }
    out.providers[name].rows.push(row);
    console.log(
      `${name.padEnd(7)} ${row.valid ? "ok " : "BAD"} ${String(row.latency_ms).padStart(6)}ms  acc=${row.accuracy == null ? "-" : row.accuracy.toFixed(2)}  ${expected.q}`,
    );
  }
}
for (const [name, p] of Object.entries(out.providers)) {
  const n = p.rows.length,
    ok = p.rows.filter((r) => r.valid).length,
    scored = p.rows.filter((r) => r.accuracy != null);
  p.summary = {
    queries: n,
    schema_ok: `${ok}/${n}`,
    mean_accuracy:
      Math.round(
        (scored.reduce((s, r) => s + r.accuracy, 0) / (scored.length || 1)) *
          100,
      ) / 100,
    mean_latency_ms: Math.round(
      p.rows.reduce((s, r) => s + r.latency_ms, 0) / n,
    ),
  };
}
const file = join(
  dirname(fileURLToPath(import.meta.url)),
  "llm-probe.results.json",
);
writeFileSync(file, JSON.stringify(out, null, 2));
console.log("\nProvider   schema-ok  mean-acc  mean-latency");
for (const [name, p] of Object.entries(out.providers))
  console.log(
    `${name.padEnd(10)} ${p.summary.schema_ok.padEnd(10)} ${String(p.summary.mean_accuracy).padEnd(9)} ${p.summary.mean_latency_ms}ms`,
  );
console.log(`\nWrote ${file}`);
