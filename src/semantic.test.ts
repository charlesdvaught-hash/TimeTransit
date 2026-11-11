import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseQuery, shouldParse, toTerm, validateParse } from "./semantic";
import type { SemanticParseResult } from "./contracts";

const valid: SemanticParseResult = {
  original_query: "take me to partners federal credit union",
  high_priority_anchors: [
    {
      raw_term: "partners federal credit union",
      normalized_entity_name: "Partners Federal Credit Union",
    },
  ],
  flexible_categories: ["coffee shop"],
};

function llmResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("shouldParse", () => {
  it("gates on mode, +, categories, and word count", () => {
    const sentence = "take me to partners federal credit union";
    expect(shouldParse(sentence, "minimal")).toBe(true);
    expect(shouldParse(sentence, "full")).toBe(true);
    expect(shouldParse(sentence, "none")).toBe(false);
    expect(shouldParse("coffee + grocery runs", "minimal")).toBe(false);
    expect(shouldParse("coffee shops near me", "minimal")).toBe(false); // category
    expect(shouldParse("two words", "minimal")).toBe(false);
    expect(shouldParse("coffee", "minimal")).toBe(false);
  });
});

describe("validateParse", () => {
  it("accepts a well-formed result", () => {
    const v = validateParse(valid);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.result).toEqual(valid);
  });
  it("rejects non-objects and missing arrays", () => {
    expect(validateParse(null).ok).toBe(false);
    expect(validateParse("x").ok).toBe(false);
    expect(validateParse([1]).ok).toBe(false);
    expect(validateParse({ original_query: "q" }).ok).toBe(false);
  });
  it("rejects empty anchor fields and empty categories", () => {
    expect(
      validateParse({
        ...valid,
        high_priority_anchors: [{ raw_term: " ", normalized_entity_name: "x" }],
      }).ok,
    ).toBe(false);
    expect(
      validateParse({
        ...valid,
        flexible_categories: ["ok", ""],
      }).ok,
    ).toBe(false);
  });
  it("requires 1–4 total stops", () => {
    expect(
      validateParse({
        ...valid,
        high_priority_anchors: [],
        flexible_categories: [],
      }).ok,
    ).toBe(false);
    expect(
      validateParse({
        ...valid,
        flexible_categories: ["a", "b", "c", "d", "e"],
      }).ok,
    ).toBe(false);
  });
});

describe("toTerm", () => {
  it("orders anchors before categories", () => {
    expect(toTerm(valid)).toBe("Partners Federal Credit Union + coffee shop");
  });
});

describe("parseQuery", () => {
  const term = "take me to partners federal credit union please";
  beforeEach(() => {
    vi.stubEnv("VITE_TRANSIT_RELAY", "https://relay.test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  it("returns null without a relay and never fetches", async () => {
    vi.stubEnv("VITE_TRANSIT_RELAY", "");
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await parseQuery(term)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
  it("posts the parse task and returns a valid result", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(llmResponse(valid));
    const r = await parseQuery("find me partners credit union now");
    expect(r).toEqual(valid);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("https://relay.test/llm");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      task: "parse",
      input: "find me partners credit union now",
    });
  });
  it("retries once with repair errors after invalid output", async () => {
    const bad = { ...valid, flexible_categories: [" "] };
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(llmResponse(bad))
      .mockResolvedValueOnce(llmResponse(valid));
    const r = await parseQuery("repair this messy sentence query");
    expect(r).toEqual(valid);
    expect(spy).toHaveBeenCalledTimes(2);
    const body = JSON.parse(String(spy.mock.calls[1][1]?.body));
    expect(body.repair.errors.length).toBeGreaterThan(0);
  });
  it("gives up when the repaired output is still invalid", async () => {
    const bad = { ...valid, high_priority_anchors: "nope" };
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(llmResponse(bad));
    expect(await parseQuery("still invalid after repair pass")).toBeNull();
    expect(spy).toHaveBeenCalledTimes(2);
  });
  it("returns null on non-2xx and network failures without repair", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(llmResponse({ error: "x" }, 502));
    expect(await parseQuery("gateway blows up here")).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockClear().mockRejectedValue(new TypeError("offline"));
    expect(await parseQuery("network goes down here")).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it("serves repeat queries from the session cache", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(llmResponse(valid));
    const t = "cached messy query worth parsing";
    expect(await parseQuery(t)).toEqual(valid);
    expect(await parseQuery(`  ${t.toUpperCase()} `)).toEqual(valid);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
