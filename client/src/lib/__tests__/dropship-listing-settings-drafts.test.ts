import { describe, expect, it } from "vitest";
import { DropshipApiError } from "../dropship-ops-surface";
import { LISTING_SETUP_RELOAD_MESSAGE } from "../dropship-ebay-listing-setup";
import { LISTING_SETTINGS_BULK_WORDS, LISTING_SETTINGS_EDIT_WORDS } from "../dropship-listing-settings-words";
import {
  BULK_EDITOR_ID,
  LISTING_SETTINGS_GUARD_ID_PREFIX,
  LISTING_SETTINGS_KEY_PREFIXES,
  LISTING_SETTINGS_SAVE_WORDS,
  SAVED_FLASH_MS,
  STORE_DEFAULT_COMPACT_LABELS,
  STORE_DEFAULT_FIELDS,
  STORE_DEFAULT_LABELS,
  bothChangedFields,
  changedFields,
  classifyWriteFailure,
  countOlderSettingsDrafts,
  decideOpen,
  describeLeavePrompt,
  describeListingSettingsBar,
  failureAfterUnconfirmed,
  isDraftDirty,
  isDraftLocked,
  isSavedFlashVisible,
  nextSaveAttempt,
  productEditorId,
  reduceListingSettingsDraft,
  sameDraftValue,
  type ClassifyWriteFailureOptions,
  type ListingSettingsDraft,
  type ListingSettingsDraftAction,
  type ListingSettingsWriter,
  type WriteFailure,
  type WriteFailurePhase,
} from "../dropship-listing-settings-drafts";

const T0 = 1_760_000_000_000;
const POLICY_BASE = Object.freeze({ policyId: "ship-a" });
const SHELF_BASE = Object.freeze({ first: "10", second: null });

/** Applies actions in order, freezing every draft on the way so a mutation would throw. */
function run(actions: readonly ListingSettingsDraftAction[], start: ListingSettingsDraft | null = null): ListingSettingsDraft | null {
  return actions.reduce<ListingSettingsDraft | null>((draft, action) => {
    const next = reduceListingSettingsDraft(draft === null ? null : Object.freeze(draft), Object.freeze(action));
    return next === null ? null : Object.freeze(next);
  }, start);
}

const openShipping: ListingSettingsDraftAction = { type: "open", editor: "shipping", place: "Shipping policy", base: POLICY_BASE };
const pickB: ListingSettingsDraftAction = { type: "edit", value: { policyId: "ship-b" } };
const ATTEMPT = Object.freeze({ signature: '{"fulfillmentPolicyId":"ship-b","expectedRevision":4}', key: "ls-policy:first" });
const startSave: ListingSettingsDraftAction = { type: "startSave", attempt: ATTEMPT };

function failure(phase: WriteFailurePhase): WriteFailure {
  return { phase, message: `words for ${phase}`, code: `CODE_${phase}`, status: 400 };
}

function apiError(status: number, code: string | null, message = "Server words.", context?: Record<string, unknown>): DropshipApiError {
  return new DropshipApiError({ status, code, message, context });
}

/** A draft for shipping with one change, sent with ATTEMPT. */
function savingDraft(): ListingSettingsDraft {
  const draft = run([openShipping, pickB, startSave]);
  if (draft === null) throw new Error("expected a draft");
  return draft;
}

describe("store default rows", () => {
  it("lists the seven rows in the record's order with their names", () => {
    expect(STORE_DEFAULT_FIELDS.map((field) => STORE_DEFAULT_LABELS[field])).toEqual([
      "Price", "Shipping policy", "Return policy", "Payment policy", "eBay category", "Store shelf", "Description",
    ]);
    expect(STORE_DEFAULT_FIELDS.map((field) => STORE_DEFAULT_COMPACT_LABELS[field])).toEqual([
      "Price", "Shipping", "Returns", "Payment", "eBay category", "Store shelf", "Description",
    ]);
  });

  it("names the drawer's editor by product and refuses an id that is not a positive whole number", () => {
    expect(productEditorId(11)).toBe("product:11");
    for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => productEditorId(bad)).toThrow(/positive whole-number product id/);
    }
  });

  it("uses the plan's request key prefixes", () => {
    expect(LISTING_SETTINGS_KEY_PREFIXES).toEqual({
      policy: "ls-policy", shelf: "ls-shelf", shipFrom: "ls-ship-from", pricingApply: "ls-apply",
      category: "ls-category", description: "ls-text", sizePrice: "ls-price", productSettings: "ls-product",
      bulkSettings: "ls-bulk",
    });
  });

  it("names Set for selected's editor \"bulk\", one draft beside the others (PR 10c, D16)", () => {
    expect(BULK_EDITOR_ID).toBe("bulk");
    const product = run([{ type: "open", editor: productEditorId(11), place: "Easy Glide Soft Sleeves", base: { a: 1 } }, { type: "edit", value: { a: 2 } }]);
    // Opening the sheet while a product's drawer holds a change asks first; an unchanged one gives way.
    expect(decideOpen(product, BULK_EDITOR_ID)).toBe("ask");
    expect(decideOpen(run([{ type: "open", editor: productEditorId(11), place: "Easy Glide Soft Sleeves", base: { a: 1 } }]), BULK_EDITOR_ID)).toBe("open");
    const bulk = run([{ type: "open", editor: BULK_EDITOR_ID, place: "Set for selected", base: { a: 1 } }, { type: "edit", value: { a: 2 } }]);
    expect(bulk).toMatchObject({ editor: "bulk", place: "Set for selected", changes: 1 });
    // And the other way round: a held sheet change is asked about before the drawer or a Store defaults row opens.
    expect(decideOpen(bulk, productEditorId(11))).toBe("ask");
    expect(decideOpen(bulk, "shipping")).toBe("ask");
    expect(decideOpen(bulk, BULK_EDITOR_ID)).toBe("open");
    expect(describeListingSettingsBar({ draft: bulk, olderDraftCount: 0, saving: false })).toBe("Not saved · 1 change in Set for selected");
  });
});

describe("field comparison", () => {
  it("compares JSON-like values deeply, with a missing field equal to an undefined one", () => {
    expect(sameDraftValue({ a: [1, { b: null }] }, { a: [1, { b: null }] })).toBe(true);
    expect(sameDraftValue({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(sameDraftValue([1, 2], [2, 1])).toBe(false);
    expect(sameDraftValue({ a: "1" }, { a: 1 })).toBe(false);
    expect(sameDraftValue(null, {})).toBe(false);
    expect(sameDraftValue([], {})).toBe(false);
    expect(sameDraftValue(Number.NaN, Number.NaN)).toBe(true);
  });

  it("lists the changed fields in a stable order", () => {
    expect(changedFields({ basis: "retail", percentBps: 2000, flatCents: 0 }, { basis: "retail", percentBps: 2500, flatCents: 100 }))
      .toEqual(["percentBps", "flatCents"]);
    expect(changedFields(SHELF_BASE, { first: "10", second: null })).toEqual([]);
    expect(changedFields({}, { added: 1 })).toEqual(["added"]);
  });

  it("marks only the fields the vendor and another window both changed, to different values", () => {
    const base = { first: "10", second: "20", third: "30", fourth: "40" };
    const mine = { first: "11", second: "21", third: "30", fourth: "44" };
    const latest = { first: "12", second: "20", third: "33", fourth: "44" };
    // first: both changed, differently -> marked. second: only mine. third: only theirs. fourth: both, same value.
    expect(bothChangedFields(base, mine, latest)).toEqual(["first"]);
    expect(bothChangedFields(base, base, latest)).toEqual([]);
    expect(bothChangedFields({}, { a: 1 }, { a: 2 })).toEqual(["a"]);
  });
});

describe("reduceListingSettingsDraft", () => {
  it("opens a draft on the saved value with nothing changed", () => {
    const draft = run([openShipping]);
    expect(draft).toEqual({
      editor: "shipping", place: "Shipping policy", base: POLICY_BASE, value: POLICY_BASE, changes: 0, marked: [],
      open: true, phase: "editing", message: null, code: null, attempt: null, savedAtMs: null,
    });
    expect(isDraftDirty(draft)).toBe(false);
  });

  it("counts changes as the vendor edits, and none when the value is back to the saved one", () => {
    const changed = run([openShipping, pickB]);
    expect(changed?.changes).toBe(1);
    expect(isDraftDirty(changed)).toBe(true);
    expect(run([{ type: "edit", value: POLICY_BASE }], changed)?.changes).toBe(0);
    const shelf = run([
      { type: "open", editor: "shelf", place: "Store shelf", base: SHELF_BASE },
      { type: "edit", value: { first: "11", second: "12" } },
    ]);
    expect(shelf?.changes).toBe(2);
  });

  it("asks before a second editor opens over unsaved changes, and opens it at once over none", () => {
    const changed = run([openShipping, pickB]);
    expect(decideOpen(changed, "price")).toBe("ask");
    // The reducer never drops the changes by itself: the provider asks, then discards.
    expect(run([{ type: "open", editor: "price", place: "Price", base: {} }], changed)).toBe(changed);
    const unchanged = run([openShipping]);
    expect(decideOpen(unchanged, "price")).toBe("open");
    expect(run([{ type: "open", editor: "price", place: "Price", base: { basis: "retail" } }], unchanged)?.editor).toBe("price");
    expect(decideOpen(null, "price")).toBe("open");
  });

  it("reopens the same editor with its changes and its base kept", () => {
    const closed = run([openShipping, pickB, { type: "close" }]);
    expect(closed?.open).toBe(false);
    expect(decideOpen(closed, "shipping")).toBe("open");
    const reopened = run([{ type: "open", editor: "shipping", place: "Shipping policy", base: { policyId: "ship-z" } }], closed);
    expect(reopened).toMatchObject({ open: true, base: POLICY_BASE, value: { policyId: "ship-b" }, changes: 1 });
    // An unchanged draft takes the latest saved value instead.
    const fresh = run([openShipping, { type: "open", editor: "shipping", place: "Shipping policy", base: { policyId: "ship-z" } }]);
    expect(fresh).toMatchObject({ base: { policyId: "ship-z" }, value: { policyId: "ship-z" }, changes: 0 });
  });

  it("locks while saving: no edit, no other editor, no second save", () => {
    const saving = savingDraft();
    expect(saving).toMatchObject({ phase: "saving", attempt: ATTEMPT, changes: 1 });
    expect(isDraftLocked(saving)).toBe(true);
    expect(run([{ type: "edit", value: { policyId: "ship-c" } }], saving)).toBe(saving);
    expect(decideOpen(saving, "price")).toBe("refuse");
    expect(run([{ type: "open", editor: "price", place: "Price", base: {} }], saving)).toBe(saving);
    expect(run([{ type: "startSave", attempt: { signature: "other", key: "ls-policy:second" } }], saving)).toBe(saving);
    expect(nextSaveAttempt(saving, ATTEMPT.signature, () => "never")).toBeNull();
    expect(run([{ type: "rebase", latest: { policyId: "ship-z" } }], saving)).toBe(saving);
  });

  it("shows Saved for 3 seconds from the injected clock, then the closed draft goes away", () => {
    const saved = run([{ type: "saved", key: ATTEMPT.key, nowMs: T0 }], savingDraft());
    expect(saved).toMatchObject({ phase: "saved", changes: 0, attempt: null, savedAtMs: T0, base: { policyId: "ship-b" } });
    expect(isDraftDirty(saved)).toBe(false);
    expect(isSavedFlashVisible(saved, T0)).toBe(true);
    expect(isSavedFlashVisible(saved, T0 + SAVED_FLASH_MS - 1)).toBe(true);
    expect(isSavedFlashVisible(saved, T0 + SAVED_FLASH_MS)).toBe(false);
    expect(isSavedFlashVisible(saved, T0 - 1)).toBe(false);
    expect(SAVED_FLASH_MS).toBe(3000);
    // Still visible: a tick changes nothing.
    expect(run([{ type: "tick", nowMs: T0 + 2999 }], saved)).toBe(saved);
    // Open editor: back to editing. Closed editor: the draft goes away.
    expect(run([{ type: "tick", nowMs: T0 + 3000 }], saved)).toMatchObject({ phase: "editing", savedAtMs: null, open: true });
    const closed = run([{ type: "close" }], saved);
    expect(closed).toMatchObject({ phase: "saved", open: false });
    expect(run([{ type: "tick", nowMs: T0 + 3000 }], closed)).toBeNull();
  });

  it("keeps the confirmed save when the re-read failed, with its words", () => {
    const stale = run([{ type: "saved", key: ATTEMPT.key, nowMs: T0, viewStale: true }], savingDraft());
    expect(stale).toMatchObject({ phase: "saved_view_stale", message: "Saved. We couldn't load the latest view.", changes: 0, attempt: null });
    expect(isSavedFlashVisible(stale, T0)).toBe(false);
    expect(run([{ type: "close" }], stale)).toMatchObject({ phase: "saved_view_stale", open: false });
  });

  it("keeps the request key after an unconfirmed, unreachable or rate-limited save", () => {
    for (const phase of ["uncertain", "unreachable", "rate_limited"] as const) {
      const failed = run([{ type: "failure", key: ATTEMPT.key, failure: failure(phase) }], savingDraft());
      expect(failed).toMatchObject({ phase, attempt: ATTEMPT, changes: 1, value: { policyId: "ship-b" }, message: `words for ${phase}` });
      // Check again / Try again: the same request reuses the same key.
      expect(nextSaveAttempt(failed, ATTEMPT.signature, () => "ls-policy:new")).toBe(ATTEMPT);
      expect(run([{ type: "startSave", attempt: ATTEMPT }], failed)).toMatchObject({ phase: "saving", attempt: ATTEMPT });
    }
  });

  it("locks an unconfirmed save until it is checked again with the same request", () => {
    const uncertain = run([{ type: "failure", key: ATTEMPT.key, failure: failure("uncertain") }], savingDraft());
    expect(isDraftLocked(uncertain)).toBe(true);
    expect(run([{ type: "edit", value: { policyId: "ship-c" } }], uncertain)).toBe(uncertain);
    expect(nextSaveAttempt(uncertain, "another request", () => "ls-policy:new")).toBeNull();
    expect(run([{ type: "startSave", attempt: { signature: "another request", key: "ls-policy:new" } }], uncertain)).toBe(uncertain);
    // It still holds changes, so opening another editor asks.
    expect(decideOpen(uncertain, "price")).toBe("ask");
  });

  it("lets another editor open over an unconfirmed ship-from repair (W10), which holds no change", () => {
    const repair = Object.freeze({ signature: '{"v":1,"writer":"W10","body":{"expectedRevision":7}}', key: "ls-ship-from:first" });
    const opened = run([
      { type: "open", editor: "shipFrom", place: "Ship-from location", base: {} },
      { type: "startSave", attempt: repair },
    ]);
    // While it is sent, nothing else opens.
    expect(decideOpen(opened, "return")).toBe("refuse");
    const uncertain = run([{ type: "failure", key: repair.key, failure: failure("uncertain") }], opened);
    expect(uncertain).toMatchObject({ editor: "shipFrom", phase: "uncertain", changes: 0, attempt: repair });
    expect(isDraftDirty(uncertain)).toBe(false);
    // Check again resends the same request with the same key.
    expect(nextSaveAttempt(uncertain, repair.signature, () => "ls-ship-from:new")).toBe(repair);
    expect(decideOpen(uncertain, "shipFrom")).toBe("open");
    // There is nothing to ask about, so another editor opens without a word and the repair's key
    // goes: the next "Update now" reads the setup again first (readShipFromRepairStart).
    expect(decideOpen(uncertain, "return")).toBe("open");
    expect(decideOpen(uncertain, productEditorId(5))).toBe("open");
    expect(run([{ type: "open", editor: "return", place: "Return policy", base: { policyId: "ret-1" } }], uncertain))
      .toMatchObject({ editor: "return", phase: "editing", attempt: null });
  });

  it("clears the request key after a conflict, a refusal, a block or a reload answer, and keeps the draft", () => {
    for (const phase of ["conflict", "refused", "blocked", "reload_required"] as const) {
      const failed = run([{ type: "failure", key: ATTEMPT.key, failure: failure(phase) }], savingDraft());
      expect(failed).toMatchObject({ phase, attempt: null, changes: 1, value: { policyId: "ship-b" }, code: `CODE_${phase}` });
      expect(isDraftLocked(failed)).toBe(false);
      expect(nextSaveAttempt(failed, ATTEMPT.signature, () => "ls-policy:new")).toEqual({ signature: ATTEMPT.signature, key: "ls-policy:new" });
    }
  });

  it("keeps the draft editable after too many saves, and an edit starts a new request key", () => {
    const limited = run([{ type: "failure", key: ATTEMPT.key, failure: failure("rate_limited") }], savingDraft());
    const edited = run([{ type: "edit", value: { policyId: "ship-c" } }], limited);
    expect(edited).toMatchObject({ phase: "editing", message: null, code: null, changes: 1, value: { policyId: "ship-c" } });
    expect(nextSaveAttempt(edited, '{"fulfillmentPolicyId":"ship-c","expectedRevision":4}', () => "ls-policy:second"))
      .toEqual({ signature: '{"fulfillmentPolicyId":"ship-c","expectedRevision":4}', key: "ls-policy:second" });
  });

  it("mints one key per request and reuses it for the same request", () => {
    const draft = run([openShipping, pickB]);
    let made = 0;
    const newKey = () => `ls-policy:${++made}`;
    const first = nextSaveAttempt(draft, "body-1", newKey);
    expect(first).toEqual({ signature: "body-1", key: "ls-policy:1" });
    const sent = run([{ type: "startSave", attempt: first! }, { type: "failure", key: "ls-policy:1", failure: failure("unreachable") }], draft);
    expect(nextSaveAttempt(sent, "body-1", newKey)).toEqual(first);
    expect(nextSaveAttempt(sent, "body-2", newKey)).toEqual({ signature: "body-2", key: "ls-policy:2" });
    expect(made).toBe(2);
    expect(nextSaveAttempt(null, "body-1", newKey)).toBeNull();
  });

  it("ignores a save answer for another attempt, or one that arrives after a discard", () => {
    const saving = savingDraft();
    expect(run([{ type: "saved", key: "ls-policy:other", nowMs: T0 }], saving)).toBe(saving);
    expect(run([{ type: "failure", key: "ls-policy:other", failure: failure("refused") }], saving)).toBe(saving);
    expect(run([{ type: "discard" }, { type: "saved", key: ATTEMPT.key, nowMs: T0 }], saving)).toBeNull();
    // A late answer for a closed-and-reopened editor's earlier attempt is ignored too.
    const settled = run([{ type: "failure", key: ATTEMPT.key, failure: failure("refused") }], saving);
    expect(run([{ type: "saved", key: ATTEMPT.key, nowMs: T0 }], settled)).toBe(settled);
  });

  it("loads the latest saved value under the vendor's changes and marks the fields both changed", () => {
    const shelf = run([
      { type: "open", editor: "shelf", place: "Store shelf", base: { first: "10", second: "20" } },
      { type: "edit", value: { first: "11", second: "20" } },
      { type: "startSave", attempt: { signature: "s", key: "ls-shelf:1" } },
      { type: "failure", key: "ls-shelf:1", failure: failure("conflict") },
      { type: "rebase", latest: { first: "12", second: "22" } },
    ]);
    expect(shelf).toMatchObject({
      base: { first: "12", second: "22" },
      value: { first: "11", second: "20" },
      changes: 2,
      marked: ["first"],
      phase: "editing",
      message: LISTING_SETTINGS_SAVE_WORDS.rebased,
      attempt: null,
    });
    // A confirmed save clears the marks.
    const saved = run([{ type: "startSave", attempt: { signature: "t", key: "ls-shelf:2" } }, { type: "saved", key: "ls-shelf:2", nowMs: T0 }], shelf);
    expect(saved?.marked).toEqual([]);
  });

  it("takes the latest saved value as it is when the vendor changed nothing, so no change appears", () => {
    // Another window saved ship-z while this editor sat open and unchanged.
    const followed = run([openShipping, { type: "rebase", latest: { policyId: "ship-z" } }]);
    expect(followed).toMatchObject({
      base: { policyId: "ship-z" },
      value: { policyId: "ship-z" },
      changes: 0,
      marked: [],
      phase: "editing",
      message: null,
      attempt: null,
      open: true,
    });
    expect(isDraftDirty(followed)).toBe(false);
    // A change the vendor undid by hand leaves nothing to keep, so the draft follows the latest too.
    const reverted = run([openShipping, pickB, { type: "edit", value: POLICY_BASE }, { type: "rebase", latest: { policyId: "ship-z" } }]);
    expect(reverted).toMatchObject({ value: { policyId: "ship-z" }, changes: 0 });
    // A draft with changes keeps them on top, as before.
    expect(run([openShipping, pickB, { type: "rebase", latest: { policyId: "ship-z" } }])).toMatchObject({
      base: { policyId: "ship-z" }, value: { policyId: "ship-b" }, changes: 1, message: LISTING_SETTINGS_SAVE_WORDS.rebased,
    });
  });

  it("marks the fields the editor names on Load latest, when it names them (PR 10, C20)", () => {
    const base = { shippingPolicy: { mode: "leave" }, own: { shippingPolicy: { id: "F2" } }, expectedRevisionId: 5 };
    const mine = { ...base, shippingPolicy: { mode: "set", value: { id: "F9" } } };
    const latest = { ...base, own: { shippingPolicy: { id: "F3" } }, expectedRevisionId: 6 };
    const open: ListingSettingsDraftAction = { type: "open", editor: "product:11", place: "Sleeves", base };
    const draft = run([open, { type: "edit", value: mine }, { type: "edit", value: { ...mine, own: latest.own, expectedRevisionId: 6 } },
      { type: "rebase", latest, marked: ["shippingPolicy"] }]);
    expect(draft).toMatchObject({ changes: 1, marked: ["shippingPolicy"], phase: "editing", base: latest });
    // Without `marked`, the field-by-field comparison decides, as before.
    expect(run([open, { type: "edit", value: mine }, { type: "edit", value: { ...mine, own: latest.own, expectedRevisionId: 6 } },
      { type: "rebase", latest }])?.marked).toEqual([]);
  });

  it("closes an unchanged editor for good, and keeps a closed draft with changes", () => {
    expect(run([openShipping, { type: "close" }])).toBeNull();
    expect(run([openShipping, pickB, { type: "close" }])).toMatchObject({ open: false, changes: 1 });
    expect(run([{ type: "close" }], savingDraft())).toMatchObject({ open: false, phase: "saving" });
    expect(run([{ type: "close" }])).toBeNull();
  });

  it("discards any draft, even an unconfirmed one", () => {
    expect(run([openShipping, pickB, { type: "discard" }])).toBeNull();
    expect(run([{ type: "failure", key: ATTEMPT.key, failure: failure("uncertain") }, { type: "discard" }], savingDraft())).toBeNull();
    expect(run([{ type: "edit", value: {} }])).toBeNull();
  });
});

/** The PR 7 writers; W5 and W6 (PR 10) have their own tables below. */
type Pr7Writer = Exclude<ListingSettingsWriter, "W5" | "W6">;

describe("classifyWriteFailure", () => {
  const writers: readonly Pr7Writer[] = ["W1", "W2", "W3", "W4", "W9", "W10"];

  it("treats a dropped connection as unconfirmed for every writer", () => {
    for (const writer of writers) {
      expect(classifyWriteFailure(writer, new TypeError("Failed to fetch"))).toEqual({
        phase: "uncertain", message: "We couldn't confirm your save.", code: null, status: null,
      });
      expect(classifyWriteFailure(writer, "not an error").phase).toBe("uncertain");
    }
  });

  it("gives every writer the same too-many-saves words on a 429", () => {
    const codes: Record<Pr7Writer, string> = {
      W1: "DROPSHIP_PRICING_RATE_LIMITED", W2: "DROPSHIP_EBAY_LISTING_SETUP_RATE_LIMITED", W10: "DROPSHIP_EBAY_LISTING_SETUP_RATE_LIMITED",
      W3: "DROPSHIP_EBAY_CATEGORY_RATE_LIMITED", W4: "DROPSHIP_CONTENT_RATE_LIMITED", W9: "DROPSHIP_LISTING_PRICE_RATE_LIMITED",
    };
    for (const writer of writers) {
      expect(classifyWriteFailure(writer, apiError(429, codes[writer], "Too many price saves. Please try again in a minute."))).toEqual({
        phase: "rate_limited", message: "Too many saves in a minute. Wait a moment and try again.", code: codes[writer], status: 429,
      });
    }
  });

  /** [status, code, phase, words or null for the server's message] per writer, from each writer's routes. */
  const TABLE: Record<Pr7Writer, ReadonlyArray<readonly [number, string | null, WriteFailurePhase, string | null]>> = {
    W1: [
      [500, "DROPSHIP_PRICING_INTERNAL_ERROR", "uncertain", "We couldn't confirm your save."],
      [502, null, "uncertain", "We couldn't confirm your save."],
      [409, "DROPSHIP_PRICING_REVIEW_STALE", "conflict", "This changed in another window."],
      [409, "DROPSHIP_IDEMPOTENCY_CONFLICT", "refused", "Something changed since you last tried. Save again."],
      [422, "DROPSHIP_PRICING_REVIEW_BLOCKED", "refused", "Some sizes can't be priced this way, so nothing was saved."],
      [422, "DROPSHIP_PRICING_REVIEW_TOO_LARGE", "refused", null],
      [400, "DROPSHIP_PRICING_INVALID_INPUT", "refused", null],
      [404, "DROPSHIP_PRICING_REVIEW_NOT_FOUND", "refused", "This price check has expired. Check new prices again."],
      [403, "DROPSHIP_PRICING_NOT_ALLOWED", "blocked", "Nothing was saved."],
    ],
    W2: [
      [500, "DROPSHIP_EBAY_LISTING_SETUP_INTERNAL_ERROR", "uncertain", "We couldn't confirm your save."],
      [502, "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE", "unreachable", "Can't reach eBay right now. Nothing was saved. Try again."],
      [502, "DROPSHIP_EBAY_MANAGED_LOCATION_UNAVAILABLE", "unreachable", "Can't reach eBay right now. Nothing was saved. Try again."],
      [502, "DROPSHIP_EBAY_STORE_CATEGORIES_UNAVAILABLE", "unreachable", "Can't reach eBay right now. Nothing was saved. Try again."],
      [503, "DROPSHIP_EBAY_TOKEN_REFRESH_FAILED", "unreachable", "Can't reach eBay right now. Nothing was saved. Try again."],
      [503, "DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE", "unreachable",
        "Card Shellz is finishing shipping setup for your store, so this can't be saved yet. Reference: DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE"],
      [502, "DROPSHIP_EBAY_FULFILLMENT_SHIPSTATION_UNAVAILABLE", "unreachable",
        "Card Shellz is finishing shipping setup for your store, so this can't be saved yet. Reference: DROPSHIP_EBAY_FULFILLMENT_SHIPSTATION_UNAVAILABLE"],
      [409, "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT", "conflict", "This changed in another window."],
      [409, "DROPSHIP_LISTING_CONFIG_IDEMPOTENCY_CONFLICT", "refused", "Something changed since you last tried. Save again."],
      [422, "DROPSHIP_EBAY_FULFILLMENT_POLICY_INCOMPATIBLE", "refused",
        "This shipping policy doesn't work with Card Shellz shipping. Check eBay again, then pick another one."],
      [400, "DROPSHIP_EBAY_STORE_SHELF_DEFAULT_INVALID", "refused", "That shelf is gone from your eBay store."],
      [409, "DROPSHIP_EBAY_FULFILLMENT_SHIPSTATION_REQUIRED", "refused",
        "Card Shellz is finishing shipping setup for your store, so this can't be saved yet. Reference: DROPSHIP_EBAY_FULFILLMENT_SHIPSTATION_REQUIRED"],
      [409, "DROPSHIP_EBAY_MANAGED_LOCATION_WAREHOUSE_REQUIRED", "refused",
        "Card Shellz is finishing shipping setup for your store, so this can't be saved yet. Reference: DROPSHIP_EBAY_MANAGED_LOCATION_WAREHOUSE_REQUIRED"],
      [400, "DROPSHIP_EBAY_LISTING_SETUP_INVALID_INPUT", "refused", null],
      [404, "DROPSHIP_STORE_CONNECTION_NOT_FOUND", "refused", null],
      [409, "DROPSHIP_LISTING_CONFIG_STORE_PAUSED", "blocked", "Nothing was saved."],
      [409, "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTING", "blocked", "Nothing was saved."],
      [409, "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTED", "blocked", "Nothing was saved."],
      [409, "DROPSHIP_LISTING_CONFIG_STORE_NOT_WRITABLE", "blocked", "Nothing was saved."],
      [409, "DROPSHIP_STORE_CONNECTION_NOT_CONNECTED", "blocked", "Nothing was saved."],
      [409, "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_TOKEN_REQUIRED", "blocked", "Nothing was saved."],
      [403, "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED", "blocked", "Nothing was saved."],
      [403, "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_DENIED", "blocked", "Nothing was saved."],
      [403, "DROPSHIP_EBAY_STORE_CATEGORIES_PERMISSION_REQUIRED", "blocked", "Nothing was saved."],
      [403, "DROPSHIP_EBAY_STORE_CATEGORIES_ACCESS_DENIED", "blocked", "Nothing was saved."],
      [409, "DROPSHIP_EBAY_FULFILLMENT_MARKETPLACE_UNSUPPORTED", "blocked", "Nothing was saved."],
      [403, "DROPSHIP_ENTITLEMENT_REQUIRED", "blocked", "Nothing was saved."],
      [403, "DROPSHIP_LISTING_CONFIG_VENDOR_BLOCKED", "blocked", "Nothing was saved."],
      [428, "DROPSHIP_LISTING_CONFIG_REVISION_REQUIRED", "reload_required", LISTING_SETUP_RELOAD_MESSAGE],
    ],
    W10: [
      [500, "DROPSHIP_EBAY_LISTING_SETUP_INTERNAL_ERROR", "uncertain", "We couldn't confirm your save."],
      [502, "DROPSHIP_EBAY_MANAGED_LOCATION_INVALID_RESPONSE", "unreachable", "Can't reach eBay right now. Nothing was saved. Try again."],
      [409, "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT", "conflict", "This changed in another window."],
      [409, "DROPSHIP_EBAY_MANAGED_LOCATION_COUNTRY_UNSUPPORTED", "refused",
        "Card Shellz is finishing shipping setup for your store, so this can't be saved yet. Reference: DROPSHIP_EBAY_MANAGED_LOCATION_COUNTRY_UNSUPPORTED"],
      [409, "DROPSHIP_LISTING_CONFIG_STORE_PAUSED", "blocked", "Nothing was saved."],
      [428, "DROPSHIP_LISTING_CONFIG_REVISION_REQUIRED", "reload_required", LISTING_SETUP_RELOAD_MESSAGE],
    ],
    W3: [
      [500, "DROPSHIP_EBAY_CATEGORY_RULES_INTERNAL_ERROR", "uncertain", "We couldn't confirm your save."],
      [502, "DROPSHIP_EBAY_CATEGORIES_UNAVAILABLE", "unreachable", "Can't reach eBay right now. Nothing was saved. Try again."],
      [503, "DROPSHIP_EBAY_REFRESH_LOCK_UNAVAILABLE", "unreachable", "Can't reach eBay right now. Nothing was saved. Try again."],
      [409, "DROPSHIP_EBAY_CATEGORY_RULES_VERSION_CONFLICT", "conflict", "This changed in another window."],
      [409, "DROPSHIP_IDEMPOTENCY_CONFLICT", "refused", "Something changed since you last tried. Save again."],
      [400, "DROPSHIP_EBAY_CATEGORY_RULES_INVALID_INPUT", "refused", null],
      [413, null, "refused", null],
      [404, "DROPSHIP_EBAY_CATEGORY_NOT_FOUND", "refused", "Pick a final eBay category."],
      [403, "DROPSHIP_EBAY_CATEGORIES_PERMISSION_REQUIRED", "blocked", "Nothing was saved."],
      [403, "DROPSHIP_EBAY_CATEGORIES_ACCESS_DENIED", "blocked", "Nothing was saved."],
      [403, "DROPSHIP_EBAY_CATEGORY_RULES_NOT_ALLOWED", "blocked", "Nothing was saved."],
      [403, "DROPSHIP_EBAY_STORE_CONNECTION_BLOCKED", "blocked", "Nothing was saved."],
      [422, "DROPSHIP_EBAY_CATEGORY_MARKETPLACE_UNSUPPORTED", "blocked", "Nothing was saved."],
    ],
    W4: [
      [500, "DROPSHIP_CONTENT_INTERNAL_ERROR", "uncertain", "We couldn't confirm your save."],
      // No eBay call before the write: a gateway error may still have saved.
      [502, null, "uncertain", "We couldn't confirm your save."],
      [409, "DROPSHIP_CONTENT_VERSION_CONFLICT", "conflict", "This changed in another window."],
      [409, "DROPSHIP_IDEMPOTENCY_CONFLICT", "refused", "Something changed since you last tried. Save again."],
      [400, "DROPSHIP_CONTENT_INVALID_INPUT", "refused", "Keep each text to 4,000 characters, with no special characters."],
      [413, null, "refused", "This is too big to save here. Contact support."],
      [404, "DROPSHIP_CONTENT_NOT_AVAILABLE", "refused", null],
      [422, "DROPSHIP_CATALOG_TARGETS_TOO_LARGE", "refused", null],
      [403, "DROPSHIP_CONTENT_NOT_ALLOWED", "blocked", "Nothing was saved."],
    ],
    W9: [
      [500, "DROPSHIP_LISTING_PRICE_INTERNAL_ERROR", "uncertain", "We couldn't confirm your save."],
      [503, null, "uncertain", "We couldn't confirm your save."],
      [409, "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT", "conflict", "This changed in another window."],
      [409, "DROPSHIP_IDEMPOTENCY_CONFLICT", "refused", "Something changed since you last tried. Save again."],
      [422, "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT", "refused", null],
      // The server's words: only they say "no price" or "below the Card Shellz minimum of $X" (L1).
      [422, "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST", "refused", null],
      [422, "DROPSHIP_PRICING_RULES_NOT_CONFIGURED", "refused", null],
      [404, "DROPSHIP_LISTING_PRICE_NOT_AVAILABLE", "refused", null],
      // Also what an old dyno answers to pricingMode "inherit" during the release.
      [400, "DROPSHIP_LISTING_PRICE_INVALID_INPUT", "refused", null],
      [403, "DROPSHIP_LISTING_VENDOR_BLOCKED", "blocked", "Nothing was saved."],
      [403, "DROPSHIP_LISTING_ENTITLEMENT_BLOCKED", "blocked", "Nothing was saved."],
      [403, "DROPSHIP_LISTING_STORE_BLOCKED", "blocked", "Nothing was saved."],
    ],
  };

  for (const writer of writers) {
    it(`classifies ${writer}'s answers code by code`, () => {
      for (const [status, code, phase, words] of TABLE[writer]) {
        const result = classifyWriteFailure(writer, apiError(status, code, "Server words."));
        // The input sits beside the answer so a failing row names itself.
        expect({ input: [status, code], ...result }).toEqual({ input: [status, code], phase, message: words ?? "Server words.", code, status });
      }
    });
  }

  it("refuses an unlisted 4xx with the server's words and treats an unlisted 5xx as unconfirmed", () => {
    for (const writer of writers) {
      expect(classifyWriteFailure(writer, apiError(401, "DROPSHIP_AUTH_REQUIRED", "Sign in again."))).toMatchObject({ phase: "refused", message: "Sign in again." });
      expect(classifyWriteFailure(writer, apiError(418, null, "Odd."))).toMatchObject({ phase: "refused", message: "Odd." });
      expect(classifyWriteFailure(writer, apiError(504, null, "Gateway timeout"))).toMatchObject({ phase: "uncertain" });
      // A DropshipApiError without a failing status could not be confirmed either.
      expect(classifyWriteFailure(writer, apiError(200, null))).toMatchObject({ phase: "uncertain" });
    }
  });

  it("uses Card Shellz words, not eBay's, for a temporary Card Shellz shipping outage", () => {
    const error = apiError(503, "DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE", "Routing is unavailable.", { retryable: true });
    expect(classifyWriteFailure("W2", error)).toMatchObject({
      phase: "unreachable",
      message: "Can't check Card Shellz shipping right now. Try again in a few minutes. Reference: DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE",
    });
  });

  it("tells a bad pick from an older rule's category on a W3 refusal", () => {
    const named = (categoryId: unknown) => apiError(422, "DROPSHIP_EBAY_CATEGORY_RULE_INVALID", "Category is not a leaf.", categoryId === undefined ? undefined : { categoryId });
    expect(classifyWriteFailure("W3", named("261"), { pickedEbayCategoryId: "261" }).message).toBe("Pick a final eBay category.");
    expect(classifyWriteFailure("W3", named(261), { pickedEbayCategoryId: "261" }).message).toBe("Pick a final eBay category.");
    expect(classifyWriteFailure("W3", named("999"), { pickedEbayCategoryId: "261" }).message)
      .toBe("One of your older eBay category rules uses a category eBay no longer accepts.");
    // Card Shellz picks (no category picked): any named category is an older rule's.
    expect(classifyWriteFailure("W3", named("999"), { pickedEbayCategoryId: null }).message)
      .toBe("One of your older eBay category rules uses a category eBay no longer accepts.");
    expect(classifyWriteFailure("W3", named(undefined)).message).toBe("Pick a final eBay category.");
    expect(classifyWriteFailure("W3", named({ nested: true }), { pickedEbayCategoryId: "261" }).message).toBe("Pick a final eBay category.");
  });

  it("never returns a raw code as words", () => {
    for (const writer of writers) {
      for (const [status, code] of TABLE[writer]) {
        const { message } = classifyWriteFailure(writer, apiError(status, code, "Server words."));
        if (code !== null) expect(message === code).toBe(false);
        expect(message.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("classifyWriteFailure for W5 (PR 10, plan 3.3, D7)", () => {
  const W5 = (status: number, code: string | null, context?: Record<string, unknown>, options?: ClassifyWriteFailureOptions) =>
    classifyWriteFailure("W5", apiError(status, code, "Server words.", context), options);

  it("splits a busy answer by its reason: nothing written, or maybe written (D7a)", () => {
    expect(W5(503, "DROPSHIP_LISTING_SETTINGS_BUSY", { reason: "heavy_write_in_progress", retryAfterSeconds: 5 })).toEqual({
      phase: "unreachable", message: LISTING_SETTINGS_EDIT_WORDS.busyHeavy, code: "DROPSHIP_LISTING_SETTINGS_BUSY", status: 503, fields: [],
    });
    expect(W5(503, "DROPSHIP_LISTING_SETTINGS_BUSY", { reason: "request_key_changed" })).toMatchObject({ phase: "unreachable", message: LISTING_SETTINGS_EDIT_WORDS.busyKeyChanged });
    // A lost connection: the public context drops its `failure`, and a cut-off COMMIT may have saved.
    expect(W5(503, "DROPSHIP_LISTING_SETTINGS_BUSY")).toMatchObject({ phase: "uncertain", message: "We couldn't confirm your save." });
    expect(W5(503, "DROPSHIP_LISTING_SETTINGS_BUSY", { reason: 7 })).toMatchObject({ phase: "uncertain" });
  });

  it("makes the three fatal codes a final refusal that doesn't say nothing was saved (D7c)", () => {
    for (const code of ["DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", "DROPSHIP_LISTING_SETTINGS_REPLAY_INCOMPLETE", "DROPSHIP_LISTING_PRICE_INVARIANT_FAILED"]) {
      expect(W5(500, code)).toEqual({ phase: "refused", message: LISTING_SETTINGS_EDIT_WORDS.fatal, code, status: 500, fields: [] });
    }
    expect(LISTING_SETTINGS_EDIT_WORDS.fatal).not.toMatch(/Nothing was saved/);
    expect(W5(500, "DROPSHIP_LISTING_SETTINGS_INTERNAL_ERROR").phase).toBe("uncertain");
  });

  it("names the refused fields for a PR 9 writer only, so the PR 7 answers stay as they were", () => {
    expect(W5(422, "DROPSHIP_EBAY_LISTING_SETUP_SELECTION_INVALID", { invalidFields: ["returnPolicy", 7, "returnPolicy"] }).fields).toEqual(["returnPolicy"]);
    expect(W5(403, "DROPSHIP_LISTING_SETTINGS_EBAY_SIGN_IN_REQUIRED", { fields: ["shippingPolicy", "paymentPolicy"] }))
      .toMatchObject({ phase: "blocked", fields: ["shippingPolicy", "paymentPolicy"] });
    expect(W5(409, "DROPSHIP_EBAY_FULFILLMENT_RATE_TABLE_REQUIRED").fields).toEqual(["shippingPolicy"]);
    expect(W5(422, "DROPSHIP_LISTING_SETTINGS_EBAY_ONLY").fields).toEqual([]);
    expect(classifyWriteFailure("W5", new TypeError("Failed to fetch"))).toEqual({
      phase: "uncertain", message: "We couldn't confirm your save.", code: null, status: null, fields: [],
    });
    for (const writer of ["W1", "W2", "W3", "W4", "W9", "W10"] as const) {
      expect(classifyWriteFailure(writer, apiError(422, "X", "x", { invalidFields: ["a"] }))).not.toHaveProperty("fields");
    }
  });

  it("names the store in a product's 404 (plan 4.7)", () => {
    expect(W5(404, "DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND", undefined, { storeName: "Marz Cards" }).message)
      .toBe("This product isn't chosen for Marz Cards. Choose it in step 1.");
    expect(W5(404, "DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND").message).toBe("This product isn't chosen for your eBay store. Choose it in step 1.");
  });
});

describe("classifyWriteFailure for W6 (PR 10c, plan 3.3, 6.5)", () => {
  const W6 = (status: number, code: string | null, context?: Record<string, unknown>) =>
    classifyWriteFailure("W6", apiError(status, code, "Server words.", context));

  it("counts a version conflict's products as the server does, never the list's length (plan 6.5)", () => {
    const conflicts = [{ productId: 11, expectedRevisionId: 5, actualRevisionId: 6 }];
    expect(W6(409, "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT", { conflicts, conflictCount: 3 })).toEqual({
      phase: "conflict", message: "3 of the selected products changed in another window.",
      code: "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT", status: 409, fields: [],
    });
    expect(W6(409, "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT", { conflictCount: 1_204 }).message)
      .toBe("1,204 of the selected products changed in another window.");
    // No usable count: the save words', never a count from `conflicts`.
    for (const context of [undefined, { conflicts }, { conflictCount: 0 }, { conflictCount: "3" }, { conflictCount: 2.5 }]) {
      expect(W6(409, "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT", context).message).toBe("This changed in another window.");
    }
    // W5's conflict keeps its words.
    expect(classifyWriteFailure("W5", apiError(409, "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT", "x", { conflictCount: 3 })).message)
      .toBe("This changed in another window.");
  });

  it("words the text budget as a refusal, and a product Card Shellz deleted as a conflict Load latest gets past (plan 6.5)", () => {
    expect(W6(422, "DROPSHIP_LISTING_SETTINGS_BULK_TOO_LARGE", { textBytes: 30_000_001, maxTextBytes: 30_000_000, productCount: 3_751 })).toEqual({
      phase: "refused", message: LISTING_SETTINGS_BULK_WORDS.tooMuchText, code: "DROPSHIP_LISTING_SETTINGS_BULK_TOO_LARGE", status: 422, fields: [],
    });
    // Saving the same products again would be refused again under every new key (CLAUDE.md §6): Load latest reads them again.
    expect(W6(404, "DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND", { productId: 11 })).toMatchObject({
      phase: "conflict", message: "A selected product is no longer in the Card Shellz catalog. Load the list again.",
    });
    // The store's own text cap keeps its words (3.3 row 21), and never the banner (D8).
    expect(W6(422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", { reason: "store_text_limit" })).toMatchObject({ phase: "refused", message: LISTING_SETTINGS_EDIT_WORDS.storeTextLimit });
    // W5 can't get W6's budget: refused with the invalid words (3.3 row 22).
    expect(classifyWriteFailure("W5", apiError(422, "DROPSHIP_LISTING_SETTINGS_BULK_TOO_LARGE", "x")).message).toBe(LISTING_SETTINGS_EDIT_WORDS.invalid);
  });

  it("refuses what W6 can't be answered, and keeps the shared rows (busy, fatal, eBay values)", () => {
    for (const code of ["DROPSHIP_LISTING_SETTINGS_OLDER_RULES_PRESENT", "DROPSHIP_LISTING_PRICES_MOVED", "DROPSHIP_CATEGORY_LISTING_SETTINGS_VERSION_CONFLICT"]) {
      expect(W6(409, code)).toMatchObject({ phase: "refused", message: LISTING_SETTINGS_EDIT_WORDS.invalid });
    }
    expect(W6(503, "DROPSHIP_LISTING_SETTINGS_BUSY", { reason: "heavy_write_in_progress" })).toMatchObject({ phase: "unreachable", message: LISTING_SETTINGS_EDIT_WORDS.busyHeavy });
    expect(W6(503, "DROPSHIP_LISTING_SETTINGS_BUSY")).toMatchObject({ phase: "uncertain" });
    expect(W6(500, "DROPSHIP_LISTING_SETTINGS_REPLAY_INCOMPLETE")).toMatchObject({ phase: "refused", message: LISTING_SETTINGS_EDIT_WORDS.fatal });
    expect(W6(422, "DROPSHIP_EBAY_STORE_CATEGORY_INVALID", { reason: "not_found", invalidFields: ["storeShelf"] })).toMatchObject({ phase: "refused", fields: ["storeShelf"] });
    expect(W6(403, "DROPSHIP_LISTING_SETTINGS_EBAY_SIGN_IN_REQUIRED", { fields: ["ebayCategory"] })).toMatchObject({ phase: "blocked", fields: ["ebayCategory"] });
  });
});

describe("failureAfterUnconfirmed (D7b)", () => {
  const answer = (phase: WriteFailurePhase): WriteFailure => ({ phase, message: `words for ${phase}`, code: "C", status: 503, fields: [] });

  it("keeps a Check again unconfirmed when the answer only says not now", () => {
    expect(failureAfterUnconfirmed(true, answer("unreachable"))).toEqual({ ...answer("unreachable"), phase: "uncertain", message: LISTING_SETTINGS_EDIT_WORDS.stillUnconfirmed });
    expect(failureAfterUnconfirmed(true, answer("rate_limited"))).toEqual({
      ...answer("rate_limited"), phase: "uncertain", message: LISTING_SETTINGS_EDIT_WORDS.stillUnconfirmedRateLimited,
    });
    for (const words of [LISTING_SETTINGS_EDIT_WORDS.stillUnconfirmed, LISTING_SETTINGS_EDIT_WORDS.stillUnconfirmedRateLimited]) {
      expect(words.startsWith("We couldn't confirm your save.")).toBe(true);
      expect(words).not.toMatch(/Nothing was saved/);
    }
  });

  it("leaves every other answer, and any answer to a first send, as it is", () => {
    for (const phase of ["uncertain", "conflict", "refused", "blocked", "reload_required"] as const) {
      expect(failureAfterUnconfirmed(true, answer(phase))).toEqual(answer(phase));
    }
    expect(failureAfterUnconfirmed(false, answer("unreachable"))).toEqual(answer("unreachable"));
    expect(failureAfterUnconfirmed(false, answer("rate_limited"))).toEqual(answer("rate_limited"));
  });

  it("keeps a Check again unconfirmed when the write gate refuses it, before the replay probe; no other block", () => {
    const block = (code: string | null): WriteFailure => ({ phase: "blocked", message: "Nothing was saved.", code, status: 403, fields: [] });
    for (const code of [
      "DROPSHIP_LISTING_VENDOR_BLOCKED", "DROPSHIP_LISTING_ENTITLEMENT_BLOCKED", "DROPSHIP_LISTING_STORE_BLOCKED",
      "DROPSHIP_STORE_CONNECTION_REQUIRED", "DROPSHIP_LISTING_SETTINGS_EBAY_ONLY",
    ]) {
      expect(failureAfterUnconfirmed(true, block(code))).toEqual({ ...block(code), phase: "uncertain", message: LISTING_SETTINGS_SAVE_WORDS.uncertain });
      expect(failureAfterUnconfirmed(false, block(code))).toEqual(block(code));
    }
    // eBay's checks run only for a key not used yet: their block shows the first send saved nothing.
    for (const code of ["DROPSHIP_LISTING_SETTINGS_EBAY_SIGN_IN_REQUIRED", "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_DENIED", "DROPSHIP_EBAY_FULFILLMENT_MARKETPLACE_UNSUPPORTED", null]) {
      expect(failureAfterUnconfirmed(true, block(code))).toEqual(block(code));
    }
  });

  it("keeps the request key, so the next Check again resends the same request", () => {
    const sent = run([{ type: "failure", key: ATTEMPT.key, failure: failure("uncertain") }, startSave], savingDraft());
    const still = run([{ type: "failure", key: ATTEMPT.key, failure: failureAfterUnconfirmed(true, answer("unreachable")) }], sent);
    expect(still).toMatchObject({ phase: "uncertain", attempt: ATTEMPT });
    expect(isDraftLocked(still)).toBe(true);
  });
});

describe("describeListingSettingsBar", () => {
  const draft = (changes: number, place = "Price", phase: ListingSettingsDraft["phase"] = "editing") => ({ place, changes, phase });

  it("says what is saved, not saved or saving", () => {
    expect(describeListingSettingsBar({ draft: null, olderDraftCount: 0, saving: false })).toBe("All saved");
    expect(describeListingSettingsBar({ draft: draft(0), olderDraftCount: 0, saving: false })).toBe("All saved");
    expect(describeListingSettingsBar({ draft: draft(1, "Shipping policy"), olderDraftCount: 0, saving: false }))
      .toBe("Not saved · 1 change in Shipping policy");
    expect(describeListingSettingsBar({ draft: draft(2), olderDraftCount: 0, saving: false })).toBe("Not saved · 2 changes in Price");
    expect(describeListingSettingsBar({ draft: draft(1, "Easy Glide Soft Sleeves", "uncertain"), olderDraftCount: 0, saving: false }))
      .toBe("Not saved · 1 change in Easy Glide Soft Sleeves");
    expect(describeListingSettingsBar({ draft: null, olderDraftCount: 2, saving: false })).toBe("Not saved · changes in Older settings");
    expect(describeListingSettingsBar({ draft: draft(0, "Price", "saved"), olderDraftCount: 0, saving: false })).toBe("All saved");
  });

  it("says Saving… while any save is in flight, before anything else", () => {
    expect(describeListingSettingsBar({ draft: draft(1, "Price", "saving"), olderDraftCount: 0, saving: false })).toBe("Saving…");
    expect(describeListingSettingsBar({ draft: draft(2), olderDraftCount: 1, saving: true })).toBe("Saving…");
  });

  it("names the step's own draft before the older panels'", () => {
    expect(describeListingSettingsBar({ draft: draft(1, "Store shelf"), olderDraftCount: 3, saving: false })).toBe("Not saved · 1 change in Store shelf");
  });

  it("counts only the older panels' leave-guard drafts as Older settings", () => {
    expect(LISTING_SETTINGS_GUARD_ID_PREFIX).toBe("listing-settings:");
    expect(countOlderSettingsDrafts([])).toBe(0);
    expect(countOlderSettingsDrafts([
      { id: "listing-settings:22" }, { id: "listing-setup:22" }, { id: "pricing-rules:22" }, { id: "exact-price:22" },
    ])).toBe(3);
  });
});

describe("describeLeavePrompt (from the drafts module)", () => {
  const discard = () => undefined;

  it("counts one and two changes", () => {
    expect(describeLeavePrompt([{ id: "listing-settings:22", label: "Price", changes: 1, discard }])).toBe("You have 1 change that isn't saved.");
    expect(describeLeavePrompt([{ id: "listing-settings:22", label: "Price", changes: 2, discard }])).toBe("You have 2 changes that aren't saved.");
  });
});
