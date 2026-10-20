import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  buildChooseSelectionSave,
  chooseMarksKey,
  rulesFingerprint,
  toSelectionRuleInput,
  type ChooseCatalogRow,
  type ChooseMark,
  type ChooseSelectionRule,
} from "../dropship-catalog-choose";
import { ChooseUnverifiedAnswerError } from "../dropship-catalog-choose";
import {
  checkChoosePending,
  ChooseReadError,
  chooseCatalogQueryOptions,
  chooseCatalogUrl,
  chooseReadErrorData,
  putChooseSelectionRules,
  readChooseCatalogPage,
  runChooseSave,
  selectionRulesQueryOptions,
  type ChoosePendingSave,
  type ChooseSaveBody,
  type ChooseSaveDeps,
} from "../dropship-catalog-choose-requests";
import { CHOOSE_WORDS } from "../dropship-catalog-choose-words";
import { DropshipApiError } from "../dropship-ops-surface";

function rule(id: number, scopeType: ChooseSelectionRule["scopeType"], action: ChooseSelectionRule["action"], target: Partial<ChooseSelectionRule> = {}): ChooseSelectionRule {
  return Object.freeze({
    id, revisionId: 3, scopeType, action, productLineId: null, productId: null, productVariantId: null, category: null,
    autoConnectNewSkus: action === "include", autoListNewSkus: false, priority: action === "include" ? 100 : 200,
    metadata: { source: "portal_catalog" }, isActive: true, ...target,
  });
}

const RULES: readonly ChooseSelectionRule[] = Object.freeze([
  rule(1, "variant", "include", { productVariantId: 101 }),
  rule(2, "category", "include", { category: "Mailers", priority: 50 }),
]);
const FINGERPRINT = rulesFingerprint(RULES);
const ADD_105: ChooseMark = Object.freeze<ChooseMark>({ productVariantId: 105, to: "selected", basis: { reason: "missing_vendor_include_rule", includeRuleIds: [], excludeRuleIds: [] } });
const REMOVE_101: ChooseMark = Object.freeze<ChooseMark>({ productVariantId: 101, to: "not_selected", basis: { reason: "selected", includeRuleIds: [1, 2], excludeRuleIds: [] } });
const MARKS = Object.freeze([REMOVE_101, ADD_105]);

/** The rules after a committed save of `sent`: the same content under new ids. */
function committed(sent: ChooseSaveBody, firstId = 900): ChooseSelectionRule[] {
  return sent.rules.map((input, index) => rule(firstId + index, input.scopeType, input.action, {
    productLineId: input.productLineId ?? null, productId: input.productId ?? null, productVariantId: input.productVariantId ?? null,
    category: input.category ?? null, autoConnectNewSkus: input.autoConnectNewSkus, autoListNewSkus: input.autoListNewSkus,
    priority: input.priority, metadata: input.metadata,
  }));
}

const busy = () => new DropshipApiError({ status: 409, code: "PUBLICATION_SELECTION_BUSY",
  message: "A stock update is finishing. Your selection was not saved; retry it in a moment." });

/** Injected deps with scripted answers; every call is recorded in order. */
function harness(reads: Array<readonly ChooseSelectionRule[] | Error>, puts: Array<{ idempotentReplay: boolean } | Error>) {
  const calls: string[] = [];
  const bodies: ChooseSaveBody[] = [];
  const sleeps: number[] = [];
  let keys = 0;
  const deps: ChooseSaveDeps = {
    readRules: async () => {
      calls.push("GET");
      const next = reads.shift();
      if (next === undefined) throw new Error("unscripted read");
      if (next instanceof Error) throw next;
      return next;
    },
    putRules: async (body) => {
      calls.push("PUT");
      bodies.push(body);
      const next = puts.shift();
      if (next === undefined) throw new Error("unscripted put");
      if (next instanceof Error) throw next;
      return next;
    },
    sleep: async (ms) => { sleeps.push(ms); },
    newKey: () => { keys += 1; return `catalog-selection:key-${keys}`; },
  };
  return { deps, calls, bodies, sleeps, keyCount: () => keys };
}

describe("runChooseSave", () => {
  it("S1 saves on the first try: one fresh read, one PUT of exactly the builder's rules", async () => {
    const run = harness([RULES], [{ idempotentReplay: false }]);
    const outcome = await runChooseSave(run.deps, { marks: MARKS, baseFingerprint: FINGERPRINT, pending: null });
    expect(outcome).toEqual({ kind: "saved", replay: false });
    expect(run.calls).toEqual(["GET", "PUT"]);
    expect(run.bodies).toEqual([{ idempotencyKey: "catalog-selection:key-1", rules: buildChooseSelectionSave(RULES, MARKS) }]);
    expect(run.sleeps).toEqual([]);
  });

  it("S2 busy, then saved: the same key and the same body, after a pause and a fresh look at the rules (review MC2)", async () => {
    const run = harness([RULES, RULES], [busy(), { idempotentReplay: false }]);
    expect(await runChooseSave(run.deps, { marks: MARKS, baseFingerprint: FINGERPRINT, pending: null })).toEqual({ kind: "saved", replay: false });
    expect(run.calls).toEqual(["GET", "PUT", "GET", "PUT"]);
    expect(run.bodies[1]).toBe(run.bodies[0]);
    expect(run.sleeps).toEqual([1_000]);
    expect(run.keyCount()).toBe(1);
  });

  it("S3 no answer, then a replay: saved", async () => {
    const run = harness([RULES, RULES], [new TypeError("Failed to fetch"), { idempotentReplay: true }]);
    expect(await runChooseSave(run.deps, { marks: MARKS, baseFingerprint: FINGERPRINT, pending: null })).toEqual({ kind: "saved", replay: true });
    expect(run.bodies[1].idempotencyKey).toBe(run.bodies[0].idempotencyKey);
  });

  it("S4 three tries without an answer, then the rules show our content under new ids: saved", async () => {
    const sent = { idempotencyKey: "catalog-selection:key-1", rules: buildChooseSelectionSave(RULES, MARKS) };
    const run = harness([RULES, RULES, RULES, committed(sent)], [new DropshipApiError({ status: 500, message: "x" }), new TypeError("x"), new DropshipApiError({ status: 503, message: "x" })]);
    expect(await runChooseSave(run.deps, { marks: MARKS, baseFingerprint: FINGERPRINT, pending: null })).toEqual({ kind: "saved", replay: true });
    expect(run.calls).toEqual(["GET", "PUT", "GET", "PUT", "GET", "PUT", "GET"]);
    expect(run.sleeps).toEqual([1_000, 2_000]);
    expect(new Set(run.bodies.map((body) => body.idempotencyKey))).toEqual(new Set(["catalog-selection:key-1"]));
  });

  it("S5 three busy answers and the rules unchanged: not saved (busy writes nothing), the attempt kept", async () => {
    const lastError = busy();
    const run = harness([RULES, RULES, RULES, RULES], [busy(), busy(), lastError]);
    const outcome = await runChooseSave(run.deps, { marks: MARKS, baseFingerprint: FINGERPRINT, pending: null });
    expect(outcome).toEqual({
      kind: "notSaved",
      busyMessage: "A stock update is finishing. Your selection was not saved; retry it in a moment.",
      error: lastError,
      pending: { idempotencyKey: "catalog-selection:key-1", body: run.bodies[0], baseFingerprint: FINGERPRINT, marksKey: chooseMarksKey(MARKS), mayHaveCommitted: false },
    });
  });

  it("S6 the next press with the same marks resends the same key and body, and makes no new key", async () => {
    const first = harness([RULES, RULES, RULES, RULES], [new TypeError("x"), new TypeError("x"), new TypeError("x")]);
    const failed = await runChooseSave(first.deps, { marks: MARKS, baseFingerprint: FINGERPRINT, pending: null });
    if (failed.kind !== "unconfirmed") throw new Error("expected a kept attempt");
    const again = harness([RULES], [{ idempotentReplay: false }]);
    expect(await runChooseSave(again.deps, { marks: [ADD_105, REMOVE_101], baseFingerprint: FINGERPRINT, pending: failed.pending }))
      .toEqual({ kind: "saved", replay: false });
    expect(again.bodies[0]).toBe(failed.pending.body);
    expect(again.keyCount()).toBe(0);
  });

  it("S7 the next press after the earlier try went through: nothing sent, it says so", async () => {
    const body = { idempotencyKey: "catalog-selection:key-1", rules: buildChooseSelectionSave(RULES, MARKS) };
    const pending: ChoosePendingSave = { idempotencyKey: body.idempotencyKey, body, baseFingerprint: FINGERPRINT, marksKey: chooseMarksKey(MARKS), mayHaveCommitted: true };
    const run = harness([committed(body)], []);
    // The marks the earlier save sent come back, so the page can drop them all (review MC3).
    expect(await runChooseSave(run.deps, { marks: [ADD_105], baseFingerprint: FINGERPRINT, pending })).toEqual({ kind: "committedEarlier", marksKey: chooseMarksKey(MARKS) });
    expect(run.calls).toEqual(["GET"]);
  });

  it("S8 another tab saved since the first change: nothing sent", async () => {
    const moved = [...RULES, rule(3, "variant", "include", { productVariantId: 300 })];
    const run = harness([moved], []);
    expect(await runChooseSave(run.deps, { marks: MARKS, baseFingerprint: FINGERPRINT, pending: null })).toEqual({ kind: "stale" });
    expect(run.calls).toEqual(["GET"]);
    expect(run.keyCount()).toBe(0);
  });

  it("S9 a 400 is sent once, never again", async () => {
    const run = harness([RULES], [new DropshipApiError({ status: 400, code: "DROPSHIP_VENDOR_CATALOG_INVALID_INPUT", message: "Dropship vendor catalog input failed validation." })]);
    expect(await runChooseSave(run.deps, { marks: MARKS, baseFingerprint: FINGERPRINT, pending: null })).toEqual({ kind: "rejected", message: CHOOSE_WORDS.rejected });
    expect(run.calls).toEqual(["GET", "PUT"]);
    expect(run.sleeps).toEqual([]);
  });

  it("S10 a 403 shows the server's words, never sent again", async () => {
    const run = harness([RULES], [new DropshipApiError({ status: 403, code: "DROPSHIP_VENDOR_CATALOG_ACCESS_BLOCKED", message: "Dropship vendor status does not allow catalog access." })]);
    expect(await runChooseSave(run.deps, { marks: MARKS, baseFingerprint: FINGERPRINT, pending: null }))
      .toEqual({ kind: "rejected", message: "Dropship vendor status does not allow catalog access." });
    expect(run.calls).toEqual(["GET", "PUT"]);
  });

  it("S11 past the 500-rule cap on the rules just read: stopped before sending", async () => {
    const many = Array.from({ length: 499 }, (_, index) => rule(10 + index, "variant", "include", { productVariantId: 5_000 + index }));
    const marks: ChooseMark[] = [ADD_105, { ...ADD_105, productVariantId: 106 }];
    const run = harness([many], []);
    expect(await runChooseSave(run.deps, { marks, baseFingerprint: rulesFingerprint(many), pending: null }))
      .toEqual({ kind: "blocked", block: { kind: "tooManyRules", count: 501 } });
    expect(run.calls).toEqual(["GET"]);
    expect(run.keyCount()).toBe(0);
  });

  it("S12 the rules can't be read: not saved, nothing sent, an earlier attempt kept", async () => {
    const readError = new TypeError("Failed to fetch");
    const run = harness([readError], []);
    expect(await runChooseSave(run.deps, { marks: MARKS, baseFingerprint: FINGERPRINT, pending: null }))
      .toEqual({ kind: "notSaved", pending: null, busyMessage: null, error: readError });
    expect(run.calls).toEqual(["GET"]);
    const pending: ChoosePendingSave = { idempotencyKey: "k".repeat(10), body: { idempotencyKey: "k".repeat(10), rules: [] }, baseFingerprint: FINGERPRINT, marksKey: "x", mayHaveCommitted: false };
    const kept = harness([readError], []);
    expect(await runChooseSave(kept.deps, { marks: MARKS, baseFingerprint: FINGERPRINT, pending })).toMatchObject({ kind: "notSaved", pending });
    // An earlier attempt that may have gone through stays unconfirmed (review MC1).
    const unsure = { ...pending, mayHaveCommitted: true };
    const still = harness([readError], []);
    expect(await runChooseSave(still.deps, { marks: MARKS, baseFingerprint: FINGERPRINT, pending: unsure })).toEqual({ kind: "unconfirmed", pending: unsure, error: readError });
  });

  it("S13 changes made after a failed try get a new key, and the stale check still applies", async () => {
    const body = { idempotencyKey: "catalog-selection:old", rules: buildChooseSelectionSave(RULES, MARKS) };
    const pending: ChoosePendingSave = { idempotencyKey: body.idempotencyKey, body, baseFingerprint: FINGERPRINT, marksKey: chooseMarksKey(MARKS), mayHaveCommitted: false };
    const run = harness([RULES], [{ idempotentReplay: false }]);
    expect(await runChooseSave(run.deps, { marks: [ADD_105], baseFingerprint: FINGERPRINT, pending })).toEqual({ kind: "saved", replay: false });
    expect(run.bodies[0].idempotencyKey).toBe("catalog-selection:key-1");
    expect(run.bodies[0].rules).toEqual(buildChooseSelectionSave(RULES, [ADD_105]));
    const moved = harness([[...RULES, rule(3, "catalog", "exclude")]], []);
    expect(await runChooseSave(moved.deps, { marks: [ADD_105], baseFingerprint: FINGERPRINT, pending })).toEqual({ kind: "stale" });
  });

  it("refuses to run with no changes (a programming error, before anything is read)", async () => {
    const run = harness([], []);
    await expect(runChooseSave(run.deps, { marks: [], baseFingerprint: null, pending: null })).rejects.toThrow("needs at least one change");
    expect(run.calls).toEqual([]);
  });
});

describe("the PUT", () => {
  const body: ChooseSaveBody = { idempotencyKey: "catalog-selection:key-1", rules: [toSelectionRuleInput(RULES[0])] };

  it("reads the replay flag from a 2xx answer in the route's contract", async () => {
    const sent: Array<[string, unknown]> = [];
    expect(await putChooseSelectionRules(body, async (url, payload) => { sent.push([url, payload]); return { revisionId: 4, idempotentReplay: true, rules: [] }; }))
      .toEqual({ idempotentReplay: true });
    expect(sent).toEqual([["/api/dropship/catalog/selection-rules", body]]);
  });

  it("(review CT6) a 2xx the page can't read is not taken as saved: it is unverified, for the runner to check against the rules", async () => {
    // Off the route's contract, or not JSON (putJson throws a SyntaxError only for a 2xx body; the route always answers JSON,
    // so such an answer may come from something in between).
    await expect(putChooseSelectionRules(body, async () => ({ unexpected: true }))).rejects.toBeInstanceOf(ChooseUnverifiedAnswerError);
    await expect(putChooseSelectionRules(body, async () => { throw new SyntaxError("Unexpected token <"); })).rejects.toBeInstanceOf(ChooseUnverifiedAnswerError);
  });

  it("passes every refusal through for the runner to classify", async () => {
    const refusal = busy();
    await expect(putChooseSelectionRules(body, async () => { throw refusal; })).rejects.toBe(refusal);
  });
});

describe("reads", () => {
  const ROW: ChooseCatalogRow = {
    productId: 11, productVariantId: 101, productSku: "ENV-SGL", productName: "Envelope Single Pocket", variantSku: "ENV-SGL-P50",
    variantName: "Pack of 50", category: "Mailers",
    selectionDecision: { selected: true, reason: "selected", marketplaceQuantity: 25, includeRuleIds: [1], excludeRuleIds: [] },
  };

  it("S14 both reads check their answer and say so in words when it is off contract", async () => {
    const client = new QueryClient();
    const rules = await client.fetchQuery(selectionRulesQueryOptions(async () => ({ rules: RULES })));
    expect(rules.rules).toEqual(RULES);
    const offRules = new QueryClient().fetchQuery(selectionRulesQueryOptions(async () => ({ rules: [{ id: 1, scopeType: "variant", action: "include", isActive: true }] })));
    await expect(offRules).rejects.toBeInstanceOf(ChooseReadError);
    await expect(offRules).rejects.toThrow(CHOOSE_WORDS.rulesUnreadable);

    const pageAnswer = { rows: [{ ...ROW, productLineIds: [], productLineNames: [] }], total: 1, page: 1, limit: 200, facets: { categories: [], productLines: [], products: [] } };
    const filters = { search: "", category: null, selectedOnly: false };
    const data = await new QueryClient().fetchInfiniteQuery(chooseCatalogQueryOptions(filters, async () => pageAnswer));
    expect(data.pages[0].rows).toEqual([ROW]);
    const offCatalog = readChooseCatalogPage("/api/dropship/catalog", async () => ({ ...pageAnswer, rows: [{ ...ROW, selectionDecision: { ...ROW.selectionDecision, reason: "not_selected" } }] }));
    await expect(offCatalog).rejects.toThrow(CHOOSE_WORDS.catalogUnreadable);
    await expect(offCatalog).rejects.toMatchObject({ code: "DROPSHIP_CATALOG_CHOOSE_OFF_CONTRACT", context: { read: "catalog" } });
  });

  it("S15 the list URL carries only search, category, Show, the page and 200 rows: never a product line or product", async () => {
    expect(chooseCatalogUrl({ search: "  sleeves  ", category: "Mailers", selectedOnly: true }, 2))
      .toBe("/api/dropship/catalog?search=sleeves&category=Mailers&selectedOnly=true&page=2&limit=200");
    expect(chooseCatalogUrl({ search: "", category: null, selectedOnly: false }, 1)).toBe("/api/dropship/catalog?page=1&limit=200");
    const long = chooseCatalogUrl({ search: "a".repeat(250), category: null, selectedOnly: false }, 1);
    expect(new URL(long, "http://x").searchParams.get("search")).toBe("a".repeat(200));

    const urls: string[] = [];
    const page = (number: number) => ({ rows: [{ ...ROW, productVariantId: 100 + number }], total: 450, page: number, limit: 200, facets: { categories: [] } });
    const client = new QueryClient();
    const options = chooseCatalogQueryOptions({ search: "pocket", category: null, selectedOnly: false }, async (url) => {
      urls.push(url);
      return page(Number(new URL(url, "http://x").searchParams.get("page")));
    });
    await client.fetchInfiniteQuery({ ...options, pages: 3 });
    expect(urls).toEqual([1, 2, 3].map((number) => `/api/dropship/catalog?search=pocket&page=${number}&limit=200`));
    for (const url of urls) expect(url).not.toMatch(/productLine|productId/);
  });
});

describe("review round (step 1 stage 1)", () => {
  const sentBody = () => ({ idempotencyKey: "catalog-selection:key-1", rules: buildChooseSelectionSave(RULES, MARKS) });

  it("S16 (MC1) three tries without an answer and the last read fails: unconfirmed (it may have gone through), the attempt kept", async () => {
    const readError = new TypeError("Failed to fetch");
    const run = harness([RULES, RULES, RULES, readError], [new TypeError("x"), new DropshipApiError({ status: 502, message: "x" }), new TypeError("x")]);
    const outcome = await runChooseSave(run.deps, { marks: MARKS, baseFingerprint: FINGERPRINT, pending: null });
    expect(outcome).toEqual({ kind: "unconfirmed", error: readError,
      pending: { idempotencyKey: "catalog-selection:key-1", body: run.bodies[0], baseFingerprint: FINGERPRINT, marksKey: chooseMarksKey(MARKS), mayHaveCommitted: true } });
  });

  it("S17 (MC1) no answer and then the rules read unchanged: still unconfirmed, since a late commit can land after the read", async () => {
    const run = harness([RULES, RULES, RULES, RULES], [new TypeError("x"), busy(), busy()]);
    const outcome = await runChooseSave(run.deps, { marks: MARKS, baseFingerprint: FINGERPRINT, pending: null });
    expect(outcome).toMatchObject({ kind: "unconfirmed", pending: { mayHaveCommitted: true } });
  });

  it("S18 (MC2) busy, then another tab saves during the pause: stopped, nothing sent over it", async () => {
    const moved = [...RULES, rule(3, "variant", "include", { productVariantId: 300 })];
    const run = harness([RULES, moved], [busy()]);
    expect(await runChooseSave(run.deps, { marks: MARKS, baseFingerprint: FINGERPRINT, pending: null })).toEqual({ kind: "stale" });
    expect(run.calls).toEqual(["GET", "PUT", "GET"]);
  });

  it("S19 (MC2) no answer, then the rules show our content: saved without sending again", async () => {
    const run = harness([RULES, committed(sentBody())], [new TypeError("x")]);
    expect(await runChooseSave(run.deps, { marks: MARKS, baseFingerprint: FINGERPRINT, pending: null })).toEqual({ kind: "saved", replay: true });
    expect(run.calls).toEqual(["GET", "PUT", "GET"]);
  });

  it("S20 (MC2) a look at the rules that fails sends nothing that try; the last read decides", async () => {
    const run = harness([RULES, new TypeError("x"), new TypeError("x"), committed(sentBody())], [new TypeError("x")]);
    expect(await runChooseSave(run.deps, { marks: MARKS, baseFingerprint: FINGERPRINT, pending: null })).toEqual({ kind: "saved", replay: true });
    expect(run.calls).toEqual(["GET", "PUT", "GET", "GET", "GET"]);
    expect(run.sleeps).toEqual([1_000, 2_000]);
  });

  it("S21 (CT6) an unreadable 2xx is checked against the rules: our content means saved; unchanged rules mean the same key is sent again", async () => {
    const checked = harness([RULES, committed(sentBody())], [new ChooseUnverifiedAnswerError("not JSON")]);
    expect(await runChooseSave(checked.deps, { marks: MARKS, baseFingerprint: FINGERPRINT, pending: null })).toEqual({ kind: "saved", replay: true });
    const resent = harness([RULES, RULES], [new ChooseUnverifiedAnswerError("not JSON"), { idempotentReplay: false }]);
    expect(await runChooseSave(resent.deps, { marks: MARKS, baseFingerprint: FINGERPRINT, pending: null })).toEqual({ kind: "saved", replay: false });
    expect(resent.bodies[1]).toBe(resent.bodies[0]);
  });

  it("S22 (MC1; verify V2) the check behind Undo: went through, moved some other way, not seen, or the rules can't be read", async () => {
    const body = sentBody();
    const pending: ChoosePendingSave = { idempotencyKey: body.idempotencyKey, body, baseFingerprint: FINGERPRINT, marksKey: chooseMarksKey(MARKS), mayHaveCommitted: true };
    expect(await checkChoosePending(async () => committed(body), pending)).toBe("wentThrough");
    expect(await checkChoosePending(async () => RULES, pending)).toBe("notSeen");
    // Verify V2 (pin moved from "notSeen"): the rules moved, but not to what this attempt sent (our save and another tab's
    // on top, or another tab's alone). The page must read everything again and say so, so it is its own answer.
    expect(await checkChoosePending(async () => [...RULES, rule(3, "catalog", "exclude")], pending)).toBe("moved");
    expect(await checkChoosePending(async () => [...committed(body), rule(950, "variant", "include", { productVariantId: 300 })], pending)).toBe("moved");
    expect(await checkChoosePending(async () => { throw new TypeError("x"); }, pending)).toBe("unreadable");
  });

  it("S23 (CT7) an off-contract read's code and issue paths reach the failure card as data attributes", () => {
    const error = new ChooseReadError("rules", [{ code: "invalid_type", path: ["rules", 0, "scopeType"], message: "x", expected: "string", received: "number" }]);
    expect(chooseReadErrorData(error)).toEqual({ "data-error-code": "DROPSHIP_CATALOG_CHOOSE_OFF_CONTRACT", "data-error-issues": "rules.0.scopeType:invalid_type" });
    expect(chooseReadErrorData(new Error("x"))).toEqual({});
    expect(chooseReadErrorData(null)).toEqual({});
  });
});
