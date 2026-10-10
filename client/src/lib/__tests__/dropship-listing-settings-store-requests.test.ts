import { CancelledError, QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { LISTING_SETUP_RELOAD_MESSAGE } from "../dropship-ebay-listing-setup";
import {
  decideOpen,
  nextSaveAttempt,
  reduceListingSettingsDraft,
  type EditorId,
  type ListingSettingsDraft,
  type ListingSettingsDraftAction,
} from "../dropship-listing-settings-drafts";
import {
  DropshipApiError,
  createDropshipIdempotencyKey,
  type DropshipEbayFulfillmentPolicyOption,
  type DropshipEbayListingSetupResponse,
} from "../dropship-ops-surface";
import {
  MAX_STORE_SHELVES,
  STORE_DEFAULT_EDITOR_WORDS,
  StoreSetupRequestError,
  buildStoreDefaultPolicySave,
  buildStoreShelfDefaultSave,
  buildStoreShipFromRepair,
  isStoreDefaultPolicyEditor,
  noPolicyOnEbayWords,
  parseStoreSetupAnswer,
  planFromSignature,
  planShipFromRepair,
  planStoreDefaultPolicySave,
  planStoreShelfDefaultSave,
  policyEditorChoices,
  readShipFromRepairStart,
  runStoreSetupSave,
  savedPolicyProblem,
  savedPolicyProblemWords,
  savedShippingPolicyWorks,
  savedStorePolicyId,
  policyEditorBase,
  shelfDraftFromSetup,
  shelfDraftProblem,
  shelfIdsFromDraft,
  shelfPathWords,
  shelfPickerOptions,
  shipFromRepairNeeded,
  storeSetupRequest,
  suggestedStorePolicyId,
  type RunStoreSetupSaveInput,
  type StoreSetupRequest,
  type StoreSetupSettlement,
} from "../dropship-listing-settings-store-requests";

/** The characters the server accepts in a request key (dropshipListingConfigIdempotencyKeySchema: 8 to 200 of these). */
const SERVER_REQUEST_KEY = /^[A-Za-z0-9:_-]{8,200}$/;
const STORE = 22;
const KEY = "ls-policy:0f8a1c2e-1111-4222-8333-944455556666";
const SHELF_KEY = "ls-shelf:0f8a1c2e-1111-4222-8333-944455556666";
const REPAIR_KEY = "ls-ship-from:0f8a1c2e-1111-4222-8333-944455556666";

function fulfillment(id: string, name: string, overrides: Partial<DropshipEbayFulfillmentPolicyOption> = {}): DropshipEbayFulfillmentPolicyOption {
  return { id, name, compatible: true, compatibilityChecked: true, compatibilityIssues: [], ...overrides };
}

const CAPABILITY: NonNullable<DropshipEbayListingSetupResponse["fulfillmentCapability"]> = {
  marketplaceId: "EBAY_US",
  requiredHandlingTimeBusinessDays: 2,
  destinationCountry: "US",
  destinationRegions: ["US"],
  destinationCoverageComplete: true,
  supportedServices: [{
    carrier: "USPS",
    ebayServiceCode: "USPSGround",
    serviceName: "USPS Ground Advantage",
    shipStationCarrierCode: "stamps_com",
    shipStationServiceCode: "usps_ground_advantage",
  }],
  evidenceHash: "a".repeat(64),
  source: {
    omsChannelId: 1,
    originWarehouseId: 2,
    rateBookId: 3,
    rateBookCode: "STD",
    rateTableId: 4,
    serviceLevelId: 5,
    fulfillmentRoutingRevision: 6,
  },
};

/** A setup read as PR 6's server answers it: eBay and Card Shellz shipping read, revision 7. */
function setup(overrides: Partial<DropshipEbayListingSetupResponse> = {}): DropshipEbayListingSetupResponse {
  return {
    storeConnectionId: STORE,
    marketplaceId: "EBAY_US",
    complete: true,
    missingFields: [],
    fulfillmentCapability: CAPABILITY,
    selection: { merchantLocationKey: "cs-managed", fulfillmentPolicyId: "ship-1", returnPolicyId: "ret-1", paymentPolicyId: "pay-1" },
    options: {
      merchantLocations: [],
      fulfillmentPolicies: [
        fulfillment("ship-1", "Free Standard US"),
        fulfillment("ship-2", "Economy, 1 day handling", {
          compatible: false,
          compatibilityIssues: [{ code: "handling_time_too_short", message: "Handling time is too short." }],
        }),
      ],
      returnPolicies: [{ id: "ret-1", name: "30 days, buyer pays" }, { id: "ret-2", name: "No returns" }],
      paymentPolicies: [{ id: "pay-1", name: "eBay payments" }],
    },
    revision: 7,
    access: { canEdit: true, reason: null },
    checks: { ebay: "checked", fulfillment: { status: "checked" } },
    storedNames: { fulfillmentPolicyName: "Free Standard US", returnPolicyName: "30 days, buyer pays", paymentPolicyName: "eBay payments" },
    storeShelfDefault: null,
    ...overrides,
  };
}

function draftWith(attempt: ListingSettingsDraft["attempt"], phase: ListingSettingsDraft["phase"] = "editing"): ListingSettingsDraft {
  return {
    editor: "shipping",
    place: "Shipping policy",
    base: { policyId: "ship-1" },
    value: { policyId: "ship-2" },
    changes: 1,
    marked: [],
    open: true,
    phase,
    message: null,
    code: null,
    attempt,
    savedAtMs: null,
  };
}

describe("W2 policy request", () => {
  it.each([
    { kind: "shipping", field: "fulfillmentPolicyId" },
    { kind: "return", field: "returnPolicyId" },
    { kind: "payment", field: "paymentPolicyId" },
  ] as const)("sends exactly one policy field for $kind, against the read's revision", ({ kind, field }) => {
    const body = buildStoreDefaultPolicySave(setup(), kind, "  pol-9  ", KEY);
    expect(body).toEqual({ expectedRevision: 7, idempotencyKey: KEY, [field]: "pol-9" });
    expect(Object.keys(body).sort()).toEqual(["expectedRevision", field, "idempotencyKey"].sort());
  });

  it("never sends the other policies or the shelf, even when they are saved", () => {
    const body = buildStoreDefaultPolicySave(setup({ storeShelfDefault: { ids: ["s-1"], names: ["Toploaders"] } }), "return", "ret-2", KEY);
    expect(body).not.toHaveProperty("fulfillmentPolicyId");
    expect(body).not.toHaveProperty("paymentPolicyId");
    expect(body).not.toHaveProperty("storeShelfDefault");
  });

  it("throws the reload words when the read carries no revision", () => {
    for (const revision of [null, undefined, 0, -1, 1.5]) {
      expect(() => buildStoreDefaultPolicySave(setup({ revision }), "shipping", "ship-1", KEY)).toThrow(LISTING_SETUP_RELOAD_MESSAGE);
    }
    try {
      planStoreDefaultPolicySave(setup({ revision: null }), "shipping", "ship-1");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(StoreSetupRequestError);
      expect((error as StoreSetupRequestError).code).toBe("DROPSHIP_LISTING_SETTINGS_RELOAD_REQUIRED");
    }
  });

  it("refuses a blank or over-long policy id, and a store id that isn't a positive whole number", () => {
    expect(() => planStoreDefaultPolicySave(setup(), "shipping", "   ")).toThrow("Pick a shipping policy.");
    expect(() => planStoreDefaultPolicySave(setup(), "return", "x".repeat(101))).toThrow("Pick a return policy.");
    expect(() => planStoreDefaultPolicySave(setup({ storeConnectionId: 0 }), "payment", "pay-1"))
      .toThrow(expect.objectContaining({ code: "DROPSHIP_LISTING_SETTINGS_STORE_INVALID" }));
    expect(buildStoreDefaultPolicySave(setup(), "return", "x".repeat(100), KEY).returnPolicyId).toHaveLength(100);
  });

  it("refuses a request key the server would refuse, or one made for another writer", () => {
    const plan = planStoreDefaultPolicySave(setup(), "shipping", "ship-2");
    for (const key of ["ls-policy", "ls-policy:has space", `ls-policy:${"a".repeat(200)}`, SHELF_KEY]) {
      expect(() => storeSetupRequest(plan.signature, key)).toThrow(expect.objectContaining({ code: "DROPSHIP_LISTING_SETTINGS_REQUEST_KEY_INVALID" }));
    }
  });

  it("is a PUT to the store's listing setup", () => {
    const request = storeSetupRequest(planStoreDefaultPolicySave(setup(), "shipping", "ship-2").signature, KEY);
    expect(request).toMatchObject({ writer: "W2", method: "PUT", path: "/api/dropship/ebay/listing-setup/22" });
  });
});

describe("W2 shelf request", () => {
  it("sends one shelf, two shelves in order, or null for None, and nothing else", () => {
    expect(buildStoreShelfDefaultSave(setup(), ["s-1"], SHELF_KEY)).toEqual({ expectedRevision: 7, idempotencyKey: SHELF_KEY, storeShelfDefault: { ids: ["s-1"] } });
    expect(buildStoreShelfDefaultSave(setup(), ["s-2", "s-1"], SHELF_KEY).storeShelfDefault).toEqual({ ids: ["s-2", "s-1"] });
    const none = buildStoreShelfDefaultSave(setup({ storeShelfDefault: { ids: ["s-1"], names: ["A"] } }), null, SHELF_KEY);
    expect(none).toEqual({ expectedRevision: 7, idempotencyKey: SHELF_KEY, storeShelfDefault: null });
    expect(none).not.toHaveProperty("fulfillmentPolicyId");
  });

  it("refuses two equal shelves on this side too", () => {
    expect(() => planStoreShelfDefaultSave(setup(), ["s-1", " s-1 "])).toThrow(STORE_DEFAULT_EDITOR_WORDS.sameShelfTwice);
  });

  it("refuses no shelves, more than two, and ids the server would refuse", () => {
    expect(MAX_STORE_SHELVES).toBe(2);
    expect(() => planStoreShelfDefaultSave(setup(), [])).toThrow(expect.objectContaining({ code: "DROPSHIP_LISTING_SETTINGS_SHELF_INVALID" }));
    expect(() => planStoreShelfDefaultSave(setup(), ["a", "b", "c"])).toThrow(expect.objectContaining({ code: "DROPSHIP_LISTING_SETTINGS_SHELF_INVALID" }));
    expect(() => planStoreShelfDefaultSave(setup(), [" "])).toThrow(expect.objectContaining({ code: "DROPSHIP_LISTING_SETTINGS_SHELF_INVALID" }));
    expect(() => planStoreShelfDefaultSave(setup(), ["x".repeat(41)])).toThrow(expect.objectContaining({ code: "DROPSHIP_LISTING_SETTINGS_SHELF_INVALID" }));
  });

  it("throws the reload words without a revision", () => {
    expect(() => buildStoreShelfDefaultSave(setup({ revision: undefined }), null, SHELF_KEY)).toThrow(LISTING_SETUP_RELOAD_MESSAGE);
  });
});

describe("W10 ship-from request", () => {
  it("is a POST of the revision and the key only", () => {
    expect(buildStoreShipFromRepair(setup(), REPAIR_KEY)).toEqual({ expectedRevision: 7, idempotencyKey: REPAIR_KEY });
    const request = storeSetupRequest(planShipFromRepair(setup()).signature, REPAIR_KEY);
    expect(request).toMatchObject({ writer: "W10", method: "POST", path: "/api/dropship/ebay/listing-setup/22/ship-from/repair" });
    expect(() => buildStoreShipFromRepair(setup({ revision: null }), REPAIR_KEY)).toThrow(LISTING_SETUP_RELOAD_MESSAGE);
  });
});

describe("request keys", () => {
  it("uses the step's prefixes, and the keys they make are ones the server accepts", () => {
    expect(planStoreDefaultPolicySave(setup(), "shipping", "ship-1").keyPrefix).toBe("ls-policy");
    expect(planStoreShelfDefaultSave(setup(), null).keyPrefix).toBe("ls-shelf");
    expect(planShipFromRepair(setup()).keyPrefix).toBe("ls-ship-from");
    for (const plan of [planStoreDefaultPolicySave(setup(), "return", "ret-2"), planStoreShelfDefaultSave(setup(), ["s-1"]), planShipFromRepair(setup())]) {
      const key = createDropshipIdempotencyKey(plan.keyPrefix);
      expect(key).toMatch(SERVER_REQUEST_KEY);
      expect(() => storeSetupRequest(plan.signature, key)).not.toThrow();
    }
  });

  it("gives the same request the same signature, and any change another", () => {
    const a = planStoreDefaultPolicySave(setup(), "shipping", "ship-2");
    expect(planStoreDefaultPolicySave(setup(), "shipping", " ship-2 ").signature).toBe(a.signature);
    expect(planStoreDefaultPolicySave(setup(), "shipping", "ship-1").signature).not.toBe(a.signature);
    expect(planStoreDefaultPolicySave(setup({ revision: 8 }), "shipping", "ship-2").signature).not.toBe(a.signature);
    expect(planStoreDefaultPolicySave(setup({ storeConnectionId: 23 }), "shipping", "ship-2").signature).not.toBe(a.signature);
    expect(planStoreShelfDefaultSave(setup(), ["s-1", "s-2"]).signature).not.toBe(planStoreShelfDefaultSave(setup(), ["s-2", "s-1"]).signature);
  });

  it("reuses the key for the same request and makes a new one after an edit (with the drafts' rule)", () => {
    const newKey = vi.fn(() => "ls-policy:new-key-0001");
    const first = planStoreDefaultPolicySave(setup(), "shipping", "ship-2");
    const sent = draftWith({ signature: first.signature, key: KEY }, "unreachable");
    expect(nextSaveAttempt(sent, first.signature, newKey)).toEqual({ signature: first.signature, key: KEY });
    expect(newKey).not.toHaveBeenCalled();
    const edited = planStoreDefaultPolicySave(setup(), "shipping", "ship-1");
    expect(nextSaveAttempt(sent, edited.signature, newKey)?.key).toBe("ls-policy:new-key-0001");
    // An unconfirmed save only ever sends its own request again.
    expect(nextSaveAttempt(draftWith({ signature: first.signature, key: KEY }, "uncertain"), edited.signature, newKey)).toBeNull();
  });

  it("rebuilds exactly the sent request from its signature (Check again)", () => {
    for (const plan of [
      planStoreDefaultPolicySave(setup(), "payment", "pay-1"),
      planStoreShelfDefaultSave(setup(), ["s-1", "s-2"]),
      planShipFromRepair(setup()),
    ]) {
      expect(planFromSignature(plan.signature)).toEqual(plan);
    }
    expect(storeSetupRequest(planFromSignature(planStoreShelfDefaultSave(setup(), null).signature).signature, SHELF_KEY).body)
      .toEqual({ expectedRevision: 7, idempotencyKey: SHELF_KEY, storeShelfDefault: null });
  });

  it("refuses a signature it did not make", () => {
    for (const signature of ["not json", "{}", JSON.stringify({ v: 1, writer: "W10", kind: "policy", storeConnectionId: 22, keyPrefix: "ls-policy", body: {} })]) {
      expect(() => planFromSignature(signature)).toThrow(expect.objectContaining({ code: "DROPSHIP_LISTING_SETTINGS_SIGNATURE_INVALID" }));
    }
  });
});

describe("the save answer", () => {
  it("is taken when it matches the setup contract for this store, whatever its outcome", () => {
    for (const outcome of ["changed", "unchanged", "replayed"] as const) {
      expect(parseStoreSetupAnswer({ ...setup(), outcome }, STORE)).toEqual({ ...setup(), outcome });
    }
    // A newer server may add fields; they are kept.
    expect(parseStoreSetupAnswer({ ...setup(), extra: true }, STORE)).toMatchObject({ extra: true });
  });

  it("is not taken off the contract or for another store", () => {
    expect(parseStoreSetupAnswer({ ...setup(), selection: undefined }, STORE)).toBeNull();
    expect(parseStoreSetupAnswer({ ...setup(), revision: "7" }, STORE)).toBeNull();
    expect(parseStoreSetupAnswer(setup(), 23)).toBeNull();
    expect(parseStoreSetupAnswer(null, STORE)).toBeNull();
  });
});

describe("runStoreSetupSave", () => {
  function harness(overrides: Partial<RunStoreSetupSaveInput> = {}) {
    const events: string[] = [];
    const settled: Array<{ key: string; settlement: StoreSetupSettlement }> = [];
    const sent: StoreSetupRequest[] = [];
    const input: RunStoreSetupSaveInput = {
      plan: planStoreDefaultPolicySave(setup(), "shipping", "ship-2"),
      callbacks: {
        onSaveStarted: vi.fn(() => { events.push("started"); }),
        onSaveSettled: vi.fn(() => { events.push("settled-counter"); }),
      },
      startSave: vi.fn(() => { events.push("key"); return KEY; }),
      settle: vi.fn((key: string, settlement: StoreSetupSettlement) => { events.push(`settle:${settlement.kind}`); settled.push({ key, settlement }); }),
      send: vi.fn(async (request: StoreSetupRequest) => { events.push("send"); sent.push(request); return { ...setup({ revision: 8 }), outcome: "changed" }; }),
      synchronize: vi.fn(async () => { events.push("sync"); }),
      refresh: vi.fn(async () => { events.push("refresh"); }),
      onSaved: vi.fn(() => { events.push("onSaved"); }),
      onBlocked: vi.fn(),
      ...overrides,
    };
    return { input, events, settled, sent };
  }

  it("after a 2xx, hands the answer to the sync helper, then settles Saved and calls onSaved", async () => {
    const { input, events, settled, sent } = harness();
    const result = await runStoreSetupSave(input);
    expect(sent).toEqual([{ writer: "W2", method: "PUT", path: "/api/dropship/ebay/listing-setup/22", body: { expectedRevision: 7, idempotencyKey: KEY, fulfillmentPolicyId: "ship-2" } }]);
    expect(input.synchronize).toHaveBeenCalledTimes(1);
    expect(input.synchronize).toHaveBeenCalledWith({ ...setup({ revision: 8 }), outcome: "changed" });
    expect(input.refresh).not.toHaveBeenCalled();
    expect(settled).toEqual([{ key: KEY, settlement: { kind: "saved" } }]);
    expect(events).toEqual(["started", "key", "send", "sync", "settle:saved", "onSaved", "settled-counter"]);
    expect(result).toMatchObject({ status: "settled", key: KEY, settlement: { kind: "saved" }, viewError: null });
  });

  it.each(["unchanged", "replayed"] as const)("treats a %s answer as saved and syncs it too", async (outcome) => {
    const answer = { ...setup(), outcome, options: { merchantLocations: [], fulfillmentPolicies: [], returnPolicies: [], paymentPolicies: [] }, checks: { ebay: "not_checked", fulfillment: { status: "not_checked" } } };
    const { input, settled } = harness({ send: vi.fn(async () => answer) });
    await runStoreSetupSave(input);
    expect(input.synchronize).toHaveBeenCalledWith(answer);
    expect(settled[0].settlement).toEqual({ kind: "saved" });
  });

  it("keeps the save but says the view is stale when the re-read fails", async () => {
    const failure = new Error("refetch failed");
    const { input, settled } = harness({ synchronize: vi.fn(async () => { throw failure; }) });
    const result = await runStoreSetupSave(input);
    expect(settled).toEqual([{ key: KEY, settlement: { kind: "saved_view_stale" } }]);
    expect(input.onSaved).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "settled", viewError: failure });
  });

  it("reads the setup again instead of caching an answer off the contract or for another store", async () => {
    for (const answer of [{ ok: true }, setup({ storeConnectionId: 99 })]) {
      const { input, settled } = harness({ send: vi.fn(async () => answer) });
      await runStoreSetupSave(input);
      expect(input.synchronize).not.toHaveBeenCalled();
      expect(input.refresh).toHaveBeenCalledTimes(1);
      expect(settled[0].settlement).toEqual({ kind: "saved" });
    }
  });

  it("sends nothing and takes no key when the page's counter refuses", async () => {
    const refusal = new Error("Wait for the current listing action to finish before saving listing changes.");
    const { input } = harness({ callbacks: { onSaveStarted: () => { throw refusal; }, onSaveSettled: vi.fn() } });
    const result = await runStoreSetupSave(input);
    expect(result).toEqual({ status: "not_started", reason: "callbacks_refused", error: refusal });
    expect(input.startSave).not.toHaveBeenCalled();
    expect(input.send).not.toHaveBeenCalled();
    expect(input.callbacks.onSaveSettled).not.toHaveBeenCalled();
  });

  it("sends nothing when the draft can't start a save, and still settles the counter", async () => {
    const { input, events } = harness({ startSave: vi.fn(() => null) });
    expect(await runStoreSetupSave(input)).toEqual({ status: "not_started", reason: "draft_busy" });
    expect(input.send).not.toHaveBeenCalled();
    expect(events).toEqual(["started", "settled-counter"]);
  });

  it("settles a dropped connection as unconfirmed, keeping the key for Check again", async () => {
    const { input, settled } = harness({ send: vi.fn(async () => { throw new TypeError("Failed to fetch"); }) });
    await runStoreSetupSave(input);
    expect(settled).toEqual([{ key: KEY, settlement: { kind: "failure", failure: { phase: "uncertain", message: "We couldn't confirm your save.", code: null, status: null } } }]);
    expect(input.onSaved).not.toHaveBeenCalled();
    expect(input.callbacks.onSaveSettled).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 409, code: "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT", phase: "conflict", message: "This changed in another window." },
    { status: 400, code: "DROPSHIP_EBAY_STORE_SHELF_DEFAULT_INVALID", phase: "refused", message: "That shelf is gone from your eBay store." },
    { status: 429, code: "DROPSHIP_EBAY_LISTING_SETUP_RATE_LIMITED", phase: "rate_limited", message: "Too many saves in a minute. Wait a moment and try again." },
    { status: 502, code: "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE", phase: "unreachable", message: "Can't reach eBay right now. Nothing was saved. Try again." },
    { status: 428, code: "DROPSHIP_LISTING_CONFIG_REVISION_REQUIRED", phase: "reload_required", message: LISTING_SETUP_RELOAD_MESSAGE },
    { status: 500, code: "DROPSHIP_EBAY_LISTING_SETUP_INTERNAL_ERROR", phase: "uncertain", message: "We couldn't confirm your save." },
  ])("classifies a $status $code as $phase", async ({ status, code, phase, message }) => {
    const error = new DropshipApiError({ status, code, message: "server words" });
    const { input, settled } = harness({ send: vi.fn(async () => { throw error; }) });
    await runStoreSetupSave(input);
    expect(settled[0].settlement).toEqual({ kind: "failure", failure: { phase, message, code, status } });
    expect(input.onBlocked).not.toHaveBeenCalled();
    expect(input.synchronize).not.toHaveBeenCalled();
  });

  it("reports the banner a blocked save names, or null when the reads decide", async () => {
    const signIn = new DropshipApiError({ status: 403, code: "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED", message: "x" });
    const first = harness({ send: vi.fn(async () => { throw signIn; }) });
    await runStoreSetupSave(first.input);
    expect(first.settled[0].settlement).toMatchObject({ kind: "failure", failure: { phase: "blocked" } });
    expect(first.input.onBlocked).toHaveBeenCalledWith({ kind: "sign_in", diagnosticReference: null });

    const notWritable = new DropshipApiError({ status: 409, code: "DROPSHIP_LISTING_CONFIG_STORE_NOT_WRITABLE", message: "x", context: {} });
    const second = harness({ send: vi.fn(async () => { throw notWritable; }), plan: planShipFromRepair(setup()), startSave: vi.fn(() => REPAIR_KEY) });
    await runStoreSetupSave(second.input);
    expect(second.input.send).toHaveBeenCalledTimes(1);
    expect(second.settled[0].settlement).toMatchObject({ kind: "failure", failure: { phase: "blocked" } });
    expect(second.input.onBlocked).toHaveBeenCalledWith(null);
  });

  it("settles a request it refuses to send as refused, with a new key next time", async () => {
    // A signature edited out of shape can't be sent; nothing goes to the server.
    const plan = { ...planStoreDefaultPolicySave(setup(), "shipping", "ship-2"), signature: JSON.stringify({ v: 1, writer: "W2", kind: "policy", storeConnectionId: 22, keyPrefix: "ls-policy", body: { expectedRevision: 7 } }) };
    const { input, settled } = harness({ plan });
    await runStoreSetupSave(input);
    expect(input.send).not.toHaveBeenCalled();
    expect(settled[0].settlement).toMatchObject({ kind: "failure", failure: { phase: "refused", code: "DROPSHIP_LISTING_SETTINGS_POLICY_INVALID" } });
  });

  it("sends the ship-from repair as a POST and the shelf as a PUT", async () => {
    const repair = harness({ plan: planShipFromRepair(setup()), startSave: vi.fn(() => REPAIR_KEY) });
    await runStoreSetupSave(repair.input);
    expect(repair.sent[0]).toEqual({ writer: "W10", method: "POST", path: "/api/dropship/ebay/listing-setup/22/ship-from/repair", body: { expectedRevision: 7, idempotencyKey: REPAIR_KEY } });
    const shelf = harness({ plan: planStoreShelfDefaultSave(setup(), null), startSave: vi.fn(() => SHELF_KEY) });
    await runStoreSetupSave(shelf.input);
    expect(shelf.sent[0]).toMatchObject({ method: "PUT", body: { storeShelfDefault: null } });
  });
});

describe("policy editor rules", () => {
  it("lists eBay's policies in order; a shipping policy is choosable only when it works with Card Shellz shipping", () => {
    expect(policyEditorChoices(setup(), "shipping")).toEqual([
      { id: "ship-1", name: "Free Standard US", choosable: true, fit: { fit: "works", line: "✓ Works with Card Shellz shipping" } },
      {
        id: "ship-2",
        name: "Economy, 1 day handling",
        choosable: false,
        fit: { fit: "cant_use", reason: "handling time must be 2 business days or more", line: "✗ Can't use: handling time must be 2 business days or more" },
      },
    ]);
    expect(policyEditorChoices(setup(), "return")).toEqual([
      { id: "ret-1", name: "30 days, buyer pays", choosable: true, fit: null },
      { id: "ret-2", name: "No returns", choosable: true, fit: null },
    ]);
  });

  it("suggests the lone usable policy only when none usable is saved", () => {
    const nothingSaved = setup({ selection: { merchantLocationKey: null, fulfillmentPolicyId: null, returnPolicyId: null, paymentPolicyId: null } });
    expect(suggestedStorePolicyId(nothingSaved, "shipping")).toBe("ship-1");
    expect(suggestedStorePolicyId(nothingSaved, "payment")).toBe("pay-1");
    // Two to choose from: no suggestion.
    expect(suggestedStorePolicyId(nothingSaved, "return")).toBeNull();
    // Saved and usable: nothing to suggest.
    expect(suggestedStorePolicyId(setup(), "shipping")).toBeNull();
    // Saved but gone from eBay, one left: suggested.
    expect(suggestedStorePolicyId(setup({ selection: { ...setup().selection, paymentPolicyId: "pay-gone" } }), "payment")).toBe("pay-1");
    // Without eBay's lists nothing is suggested.
    expect(suggestedStorePolicyId({ ...nothingSaved, checks: { ebay: "not_checked", fulfillment: { status: "not_checked" } } }, "payment")).toBeNull();
  });

  it("says when the saved policy is gone or no longer fits, and when it works", () => {
    expect(savedPolicyProblem(setup(), "shipping")).toBeNull();
    expect(savedShippingPolicyWorks(setup())).toBe(true);
    const noLongerFits = setup({ selection: { ...setup().selection, fulfillmentPolicyId: "ship-2" } });
    const problem = savedPolicyProblem(noLongerFits, "shipping");
    expect(problem).toEqual({ problem: "no_longer_fits", name: "Economy, 1 day handling", reason: "handling time must be 2 business days or more" });
    expect(savedPolicyProblemWords("shipping", problem!)).toBe(
      "Your shipping policy “Economy, 1 day handling” changed on eBay and no longer works with Card Shellz shipping: handling time must be 2 business days or more.",
    );
    expect(savedShippingPolicyWorks(noLongerFits)).toBe(false);

    const gone = setup({ selection: { ...setup().selection, returnPolicyId: "ret-gone" }, storedNames: { fulfillmentPolicyName: null, returnPolicyName: "Old returns", paymentPolicyName: null } });
    expect(savedPolicyProblem(gone, "return")).toEqual({ problem: "gone", name: "Old returns" });
    expect(savedPolicyProblemWords("return", { problem: "gone", name: "Old returns" })).toBe("Your return policy “Old returns” is no longer on eBay.");
    expect(savedPolicyProblemWords("payment", { problem: "gone", name: null })).toBe("Your payment policy is no longer on eBay.");
  });

  it("says nothing it can't tell: no eBay read, nothing saved, or Card Shellz shipping not checked", () => {
    expect(savedPolicyProblem(setup({ checks: { ebay: "not_checked", fulfillment: { status: "not_checked" } } }), "return")).toBeNull();
    expect(savedPolicyProblem(setup({ selection: { ...setup().selection, paymentPolicyId: null } }), "payment")).toBeNull();
    const unchecked = setup({ options: { ...setup().options, fulfillmentPolicies: [fulfillment("ship-1", "Free Standard US", { compatible: false, compatibilityChecked: false })] } });
    expect(savedPolicyProblem(unchecked, "shipping")).toBeNull();
    expect(savedShippingPolicyWorks(unchecked)).toBe(false);
  });

  it("names the saved policy and the policy editors", () => {
    expect(savedStorePolicyId(setup(), "return")).toBe("ret-1");
    expect(savedStorePolicyId(setup({ selection: { ...setup().selection, returnPolicyId: "  " } }), "return")).toBeNull();
    // The base the row and the step's [Choose] open the editor with.
    expect(policyEditorBase(setup(), "return")).toEqual({ policyId: "ret-1" });
    expect(policyEditorBase(setup({ selection: { ...setup().selection, paymentPolicyId: null } }), "payment")).toEqual({ policyId: null });
    expect(["shipping", "return", "payment"].every((editor) => isStoreDefaultPolicyEditor(editor as "shipping"))).toBe(true);
    expect(isStoreDefaultPolicyEditor("shelf")).toBe(false);
    expect(isStoreDefaultPolicyEditor(null)).toBe(false);
    expect(noPolicyOnEbayWords("return")).toBe("You don't have a return policy on eBay yet. Make one in eBay Seller Hub, then check again.");
  });
});

describe("shelf editor rules", () => {
  it("starts from the saved default", () => {
    expect(shelfDraftFromSetup(setup())).toEqual({ first: null, second: null });
    expect(shelfDraftFromSetup(setup({ storeShelfDefault: { ids: ["s-1"], names: ["A"] } }))).toEqual({ first: "s-1", second: null });
    expect(shelfDraftFromSetup(setup({ storeShelfDefault: { ids: ["s-1", "s-2"], names: ["A", "B"] } }))).toEqual({ first: "s-1", second: "s-2" });
  });

  it("needs a first shelf before a second, and two different shelves", () => {
    expect(shelfDraftProblem({ first: null, second: null })).toBeNull();
    expect(shelfDraftProblem({ first: "s-1", second: null })).toBeNull();
    expect(shelfDraftProblem({ first: null, second: "s-2" })).toBe("Pick a first shelf first");
    expect(shelfDraftProblem({ first: "s-1", second: "s-1" })).toBe("Pick two different shelves.");
    expect(shelfIdsFromDraft({ first: null, second: null })).toBeNull();
    expect(shelfIdsFromDraft({ first: "s-1", second: null })).toEqual(["s-1"]);
    expect(shelfIdsFromDraft({ first: "s-1", second: "s-2" })).toEqual(["s-1", "s-2"]);
    expect(() => shelfIdsFromDraft({ first: null, second: "s-2" })).toThrow("Pick a first shelf first");
  });

  it("shows shelf paths in the record's words", () => {
    expect(shelfPathWords("Supplies:Toploaders")).toBe("Supplies › Toploaders");
    expect(shelfPathWords("Toploaders")).toBe("Toploaders");
    expect(shelfPathWords(" Supplies : Penny Sleeves ")).toBe("Supplies › Penny Sleeves");
  });

  it("offers the live shelves, plus a saved shelf eBay no longer lists, marked so", () => {
    const live = [{ categoryId: "s-1", categoryName: "Toploaders", path: "Supplies:Toploaders", level: 2 }];
    expect(shelfPickerOptions(live, null)).toEqual([{ categoryId: "s-1", categoryName: "Toploaders", path: "Supplies › Toploaders", level: 2 }]);
    const options = shelfPickerOptions(live, { ids: ["s-1", "s-9"], names: ["Supplies:Toploaders", "Old:Sleeves"] });
    expect(options.map((option) => option.path)).toEqual(["Supplies › Toploaders", "Old › Sleeves (no longer in your eBay store)"]);
    expect(live[0].path).toBe("Supplies:Toploaders");
  });

  it("says nothing about a saved shelf while the live list can't be read, and never shows its id", () => {
    expect(shelfPickerOptions(null, { ids: ["s-9", "s-8"], names: ["Old:Sleeves", " "] }).map((option) => option.path))
      .toEqual(["Old › Sleeves", "A shelf"]);
    expect(shelfPickerOptions(null, null)).toEqual([]);
  });
});

describe("ship-from", () => {
  const MISSING = ["merchantLocationKey"];

  it("is needed only when eBay's listing location is missing", () => {
    expect(shipFromRepairNeeded(setup())).toBe(false);
    expect(shipFromRepairNeeded(setup({ missingFields: MISSING }))).toBe(true);
  });

  it("plans a new repair only from the setup read again at the click", async () => {
    // The cached read says revision 7; the server is at 8 and the location is still missing.
    const fresh = setup({ revision: 8, missingFields: MISSING });
    const read = vi.fn(async () => ({ data: fresh, error: null }));
    const start = await readShipFromRepairStart(read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(start).toEqual({ kind: "repair", setup: fresh });
    if (start.kind !== "repair") throw new Error("expected a repair");
    expect(buildStoreShipFromRepair(start.setup, REPAIR_KEY)).toEqual({ expectedRevision: 8, idempotencyKey: REPAIR_KEY });
  });

  it("sends nothing when the read says the location is right now (an earlier repair landed)", async () => {
    expect(await readShipFromRepairStart(async () => ({ data: setup({ revision: 8 }) }))).toEqual({ kind: "not_needed" });
  });

  it("sends nothing when the read fails, even with an older answer beside the error", async () => {
    const failure = new DropshipApiError({ status: 503, code: "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE", message: "x" });
    // React Query keeps the older answer (revision 7, location missing) next to the failed read's error.
    expect(await readShipFromRepairStart(async () => ({ data: setup({ missingFields: MISSING }), error: failure })))
      .toEqual({ kind: "read_failed", error: failure });
    expect(await readShipFromRepairStart(async () => ({}))).toEqual({ kind: "read_failed", error: null });
    const dropped = new TypeError("Failed to fetch");
    await expect(readShipFromRepairStart(async () => { throw dropped; })).resolves.toEqual({ kind: "read_failed", error: dropped });
    expect(STORE_DEFAULT_EDITOR_WORDS.shipFromCheckFailed).toBe("Couldn't check where your items ship from. Nothing was changed. Try again.");
  });

  it("counts a read cancelled in flight as failed, never as the cached answer", async () => {
    // The cached read: revision 7, location missing. The server may be at 8 (this window's own shelf save).
    const cached = setup({ missingFields: MISSING });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const queryKey = ["listing-setup"];
    client.setQueryData(queryKey, cached);
    const answers: Array<(value: DropshipEbayListingSetupResponse) => void> = [];
    const observer = new QueryObserver<DropshipEbayListingSetupResponse>(client, {
      queryKey,
      queryFn: () => new Promise<DropshipEbayListingSetupResponse>((resolve) => { answers.push(resolve); }),
    });

    // Without throwOnError, React Query hands a cancelled read back as the cached answer, no error.
    const quiet = observer.refetch();
    await client.cancelQueries({ queryKey });
    expect(await quiet).toMatchObject({ data: cached, error: null });

    // A save's cache sync cancels the read and puts the cached answer back (cancelQueries reverts).
    const synced = readShipFromRepairStart(() => observer.refetch({ throwOnError: true }));
    await client.cancelQueries({ queryKey });
    const afterSync = await synced;
    expect(afterSync.kind).toBe("read_failed");
    if (afterSync.kind === "read_failed") expect(afterSync.error).toBeInstanceOf(CancelledError);

    // Another refetch (the banner's Try again) cancels the read in flight and starts its own.
    const replaced = readShipFromRepairStart(() => observer.refetch({ throwOnError: true }));
    const other = observer.refetch();
    const afterOther = await replaced;
    expect(afterOther.kind).toBe("read_failed");
    if (afterOther.kind === "read_failed") expect(afterOther.error).toBeInstanceOf(CancelledError);
    answers[answers.length - 1](setup({ revision: 8, missingFields: MISSING }));
    await other;
    // A read that finishes is still trusted.
    const finished = readShipFromRepairStart(() => observer.refetch({ throwOnError: true }));
    answers[answers.length - 1](setup({ revision: 9, missingFields: MISSING }));
    expect(await finished).toMatchObject({ kind: "repair", setup: { revision: 9 } });
    client.clear();
  });

  /** The step's one draft, run by the real reducer, as the provider runs it. */
  function step() {
    let draft: ListingSettingsDraft | null = null;
    let made = 0;
    const apply = (action: ListingSettingsDraftAction) => { draft = reduceListingSettingsDraft(draft, action); };
    return {
      get draft() { return draft; },
      open: (editor: EditorId = "shipFrom") => {
        if (decideOpen(draft, editor) !== "open") return false;
        apply({ type: "open", editor, place: editor === "shipFrom" ? STORE_DEFAULT_EDITOR_WORDS.shipFromPlace : editor, base: {} });
        return true;
      },
      startSave: (signature: string, keyPrefix: string) => {
        const attempt = nextSaveAttempt(draft, signature, () => `${keyPrefix}:0f8a1c2e-1111-4222-8333-94445555666${++made}`);
        if (attempt === null) return null;
        apply({ type: "startSave", attempt });
        return attempt.key;
      },
      settle: (key: string, settlement: StoreSetupSettlement) => {
        apply(settlement.kind === "failure"
          ? { type: "failure", key, failure: settlement.failure }
          : { type: "saved", key, nowMs: 0, viewStale: settlement.kind === "saved_view_stale" });
      },
    };
  }

  function repairRun(drafts: ReturnType<typeof step>, plan: ReturnType<typeof planShipFromRepair>, send: RunStoreSetupSaveInput["send"]): RunStoreSetupSaveInput {
    return {
      plan,
      callbacks: { onSaveStarted: vi.fn(), onSaveSettled: vi.fn() },
      startSave: drafts.startSave,
      settle: drafts.settle,
      send,
      synchronize: vi.fn(async () => undefined),
      refresh: vi.fn(async () => undefined),
      onSaved: vi.fn(),
    };
  }

  it("after a 409, the next Update now reads again and sends the server's revision, not the refused one", async () => {
    const drafts = step();
    const cached = setup({ missingFields: MISSING }); // revision 7
    const sent: StoreSetupRequest[] = [];
    const conflict = new DropshipApiError({ status: 409, code: "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT", message: "x" });
    expect(drafts.open()).toBe(true);
    await runStoreSetupSave(repairRun(drafts, planShipFromRepair(cached), async (request) => { sent.push(request); throw conflict; }));
    expect(drafts.draft).toMatchObject({ editor: "shipFrom", phase: "conflict", message: "This changed in another window.", attempt: null });

    // Another window saved: the server is at revision 8. The click reads first.
    const start = await readShipFromRepairStart(async () => ({ data: setup({ revision: 8, missingFields: MISSING }) }));
    if (start.kind !== "repair") throw new Error("expected a repair");
    expect(drafts.open()).toBe(true);
    await runStoreSetupSave(repairRun(drafts, planShipFromRepair(start.setup), async (request) => {
      sent.push(request);
      return setup({ revision: 9 });
    }));
    expect(sent.map((request) => request.body.expectedRevision)).toEqual([7, 8]);
    expect(sent[0].body.idempotencyKey).not.toBe(sent[1].body.idempotencyKey);
    expect(drafts.draft).toMatchObject({ phase: "saved", attempt: null });
  });

  it("keeps a repair whose answer was lost until Check again, which resends the same key", async () => {
    const drafts = step();
    const cached = setup({ missingFields: MISSING });
    const sent: StoreSetupRequest[] = [];
    expect(drafts.open()).toBe(true);
    // The server commits 7 → 8, but the answer never arrives.
    await runStoreSetupSave(repairRun(drafts, planShipFromRepair(cached), async (request) => { sent.push(request); throw new TypeError("Failed to fetch"); }));
    const uncertain = drafts.draft;
    expect(uncertain).toMatchObject({ editor: "shipFrom", phase: "uncertain", changes: 0 });
    // Check again: the same request with the same key, which the server answers from the first one.
    const attempt = uncertain?.attempt;
    if (!attempt) throw new Error("expected the attempt to be kept");
    await runStoreSetupSave(repairRun(drafts, planFromSignature(attempt.signature), async (request) => {
      sent.push(request);
      return { ...setup({ revision: 8 }), outcome: "replayed" };
    }));
    expect(sent.map((request) => request.body)).toEqual([
      { expectedRevision: 7, idempotencyKey: attempt.key },
      { expectedRevision: 7, idempotencyKey: attempt.key },
    ]);
    expect(drafts.draft).toMatchObject({ phase: "saved" });
    // Had the draft gone (a reload), a new click reads first and sees the repair landed: nothing is sent.
    expect(await readShipFromRepairStart(async () => ({ data: setup({ revision: 8 }) }))).toEqual({ kind: "not_needed" });
  });

  it("sends nothing again when another editor took an unconfirmed repair's draft and the repair landed", async () => {
    const drafts = step();
    const sent: StoreSetupRequest[] = [];
    expect(drafts.open()).toBe(true);
    // The server commits 7 → 8, but the answer never arrives.
    await runStoreSetupSave(repairRun(drafts, planShipFromRepair(setup({ missingFields: MISSING })), async (request) => {
      sent.push(request);
      throw new TypeError("Failed to fetch");
    }));
    expect(drafts.draft).toMatchObject({ editor: "shipFrom", phase: "uncertain" });
    // The repair holds no change, so the Return policy editor opens over it, and its key goes.
    expect(drafts.open("return")).toBe(true);
    expect(drafts.draft).toMatchObject({ editor: "return", attempt: null });
    // The cached read still says the location is missing, so the note offers Update now again.
    // The click reads first and sees the repair landed: nothing is sent.
    expect(await readShipFromRepairStart(async () => ({ data: setup({ revision: 8 }) }))).toEqual({ kind: "not_needed" });
    expect(sent).toHaveLength(1);
  });
});
