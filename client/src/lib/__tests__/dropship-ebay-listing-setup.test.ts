import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DropshipApiError,
  putJson,
  type DropshipEbayListingSetupFulfillmentCheck,
  type DropshipEbayListingSetupResponse,
  type DropshipListingConfigReadOnlyReason,
  type ReplaceDropshipEbayListingSetupInput,
} from "../dropship-ops-surface";
import {
  LISTING_SETUP_RELOAD_MESSAGE,
  ListingSetupRequestKeys,
  buildEbayListingSetupSaveRequest,
  buildEbayShipFromRepairRequest,
  listingSetupReadOnlyMessage,
  listingSetupRevision,
  listingSetupSaveErrorMessage,
  listingSetupSavedOption,
  listingSetupShippingCheckNotice,
  listingSetupShippingChecked,
  listingSetupShowsSavedValuesOnly,
} from "../dropship-ebay-listing-setup";

/**
 * The characters the server accepts in a request key
 * (server/modules/dropship/application/dropship-listing-config-dtos.ts,
 * dropshipListingConfigIdempotencyKeySchema: 8 to 200 of these).
 */
const SERVER_REQUEST_KEY = /^[A-Za-z0-9:_-]{8,200}$/;

const DRAFT: ReplaceDropshipEbayListingSetupInput = {
  fulfillmentPolicyId: "usps-ground",
  returnPolicyId: "return-30",
  paymentPolicyId: "managed-payments",
};

/** What the server has saved for the store when the draft was loaded. */
const SAVED: DropshipEbayListingSetupResponse["selection"] = {
  merchantLocationKey: "warehouse",
  fulfillmentPolicyId: "usps-ground",
  returnPolicyId: "return-30",
  paymentPolicyId: "managed-payments",
};
const NOTHING_SAVED: DropshipEbayListingSetupResponse["selection"] = {
  merchantLocationKey: null,
  fulfillmentPolicyId: null,
  returnPolicyId: null,
  paymentPolicyId: null,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("listingSetupReadOnlyMessage", () => {
  it("says nothing when the vendor can change the settings, or the server predates access", () => {
    expect(listingSetupReadOnlyMessage({ access: { canEdit: true, reason: null } }, "Marz Cards")).toBeNull();
    expect(listingSetupReadOnlyMessage({}, "Marz Cards")).toBeNull();
    expect(listingSetupReadOnlyMessage({ access: undefined }, "Marz Cards")).toBeNull();
  });

  it.each<{ reason: DropshipListingConfigReadOnlyReason; message: string }>([
    { reason: "store_paused", message: "Marz Cards is paused, so its settings can't be changed now." },
    { reason: "store_disconnecting", message: "Marz Cards is being disconnected, so its settings can't be changed now." },
    { reason: "store_disconnected", message: "Marz Cards is disconnected, so its settings can't be changed now." },
    {
      reason: "vendor_not_active",
      message: "Your dropship account isn't active, so listing settings can't be changed. Contact support.",
    },
  ])("names why the settings are read-only for $reason", ({ reason, message }) => {
    expect(listingSetupReadOnlyMessage({ access: { canEdit: false, reason } }, "Marz Cards")).toBe(message);
  });

  it("speaks about the account, not the store, when the vendor is not active", () => {
    expect(listingSetupReadOnlyMessage({ access: { canEdit: false, reason: "vendor_not_active" } }, "Marz Cards"))
      .not.toContain("Marz Cards");
  });
});

describe("listingSetupShippingCheckNotice", () => {
  it("is shown only when Card Shellz shipping could not be read", () => {
    expect(listingSetupShippingCheckNotice({})).toBeNull();
    expect(listingSetupShippingCheckNotice({ checks: { ebay: "checked", fulfillment: { status: "checked" } } })).toBeNull();
    expect(listingSetupShippingCheckNotice({ checks: { ebay: "not_checked", fulfillment: { status: "not_checked" } } })).toBeNull();
  });

  it("tells the vendor Card Shellz is finishing shipping setup when the setup is incomplete, and passes the reference on", () => {
    const notice = listingSetupShippingCheckNotice({ checks: { ebay: "checked", fulfillment: {
      status: "unavailable", reference: "DROPSHIP_EBAY_FULFILLMENT_ROUTING_REQUIRED", kind: "setup_incomplete",
    } } });
    expect(notice).toEqual({
      message: "Card Shellz is finishing shipping setup for your store. You can pick a shipping policy when it's done.",
      reference: "DROPSHIP_EBAY_FULFILLMENT_ROUTING_REQUIRED",
    });
  });

  it("asks the vendor to try again in a few minutes when the failure is temporary", () => {
    const notice = listingSetupShippingCheckNotice({ checks: { ebay: "checked", fulfillment: {
      status: "unavailable", reference: "DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE", kind: "temporary",
    } } });
    expect(notice).toEqual({
      message: "Can't check Card Shellz shipping right now. Your saved settings still apply. Choose Refresh options in a few minutes.",
      reference: "DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE",
    });
  });

  it("tells the vendor to contact support when the store is on an eBay site Card Shellz does not list on", () => {
    const notice = listingSetupShippingCheckNotice({ checks: { ebay: "checked", fulfillment: {
      status: "unavailable", reference: "DROPSHIP_EBAY_FULFILLMENT_MARKETPLACE_UNSUPPORTED", kind: "marketplace_unsupported",
    } } });
    expect(notice).toEqual({
      message: "Card Shellz lists on eBay US only. This store is set up for another eBay site. Contact support.",
      reference: "DROPSHIP_EBAY_FULFILLMENT_MARKETPLACE_UNSUPPORTED",
    });
  });

  it.each(["temporary", "setup_incomplete", "marketplace_unsupported"] as const)(
    "keeps the staff-facing code out of the vendor's sentence for a $kind failure",
    (kind) => {
      const notice = listingSetupShippingCheckNotice({ checks: { ebay: "checked", fulfillment: {
        status: "unavailable", reference: "DROPSHIP_EBAY_FULFILLMENT_NO_RATE_BOOK", kind,
      } } });
      expect(notice?.message).not.toContain("DROPSHIP_");
      expect(notice?.reference).toBe("DROPSHIP_EBAY_FULFILLMENT_NO_RATE_BOOK");
    },
  );

  it("does not depend on whether eBay was read for the same answer", () => {
    const unavailable: DropshipEbayListingSetupFulfillmentCheck = {
      status: "unavailable", reference: "DROPSHIP_SHIPPING_CONFIG_REQUIRED", kind: "setup_incomplete",
    };
    expect(listingSetupShippingCheckNotice({ checks: { ebay: "not_checked", fulfillment: unavailable } }))
      .toMatchObject({ reference: "DROPSHIP_SHIPPING_CONFIG_REQUIRED" });
  });
});

describe("listingSetupShowsSavedValuesOnly", () => {
  it("is true only when the answer says eBay's lists were not read", () => {
    expect(listingSetupShowsSavedValuesOnly({ checks: { ebay: "not_checked", fulfillment: { status: "not_checked" } } })).toBe(true);
    expect(listingSetupShowsSavedValuesOnly({ checks: { ebay: "checked", fulfillment: { status: "checked" } } })).toBe(false);
  });

  it("does not depend on whether Card Shellz shipping was read", () => {
    expect(listingSetupShowsSavedValuesOnly({ checks: { ebay: "checked", fulfillment: {
      status: "unavailable", reference: "DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE", kind: "temporary",
    } } })).toBe(false);
  });

  it("treats an answer from a server before the check states as carrying eBay's lists", () => {
    expect(listingSetupShowsSavedValuesOnly({})).toBe(false);
  });
});

describe("listingSetupShippingChecked", () => {
  it("is true only when Card Shellz shipping was checked for this answer", () => {
    expect(listingSetupShippingChecked({ checks: { ebay: "checked", fulfillment: { status: "checked" } } })).toBe(true);
    expect(listingSetupShippingChecked({ checks: { ebay: "not_checked", fulfillment: { status: "not_checked" } } })).toBe(false);
    for (const kind of ["temporary", "setup_incomplete", "marketplace_unsupported"] as const) {
      expect(listingSetupShippingChecked({ checks: { ebay: "checked", fulfillment: {
        status: "unavailable", reference: "DROPSHIP_EBAY_FULFILLMENT_NO_RATE_BOOK", kind,
      } } }), kind).toBe(false);
    }
  });

  it("treats an answer from a server before the check states as checked, since that server always checked", () => {
    expect(listingSetupShippingChecked({})).toBe(true);
  });
});

describe("listingSetupSavedOption", () => {
  const storedNames = {
    fulfillmentPolicyName: "USPS Ground Advantage",
    returnPolicyName: "30-day returns",
    paymentPolicyName: "Managed payments",
  };

  it("offers each saved policy under the name eBay gave it at the last save", () => {
    const setup = { selection: SAVED, storedNames };
    expect(listingSetupSavedOption(setup, "fulfillmentPolicyId")).toEqual([{ id: "usps-ground", name: "USPS Ground Advantage" }]);
    expect(listingSetupSavedOption(setup, "returnPolicyId")).toEqual([{ id: "return-30", name: "30-day returns" }]);
    expect(listingSetupSavedOption(setup, "paymentPolicyId")).toEqual([{ id: "managed-payments", name: "Managed payments" }]);
  });

  it("names a saved policy by its id when no name was stored for it", () => {
    expect(listingSetupSavedOption({ selection: SAVED, storedNames: { ...storedNames, returnPolicyName: null } }, "returnPolicyId"))
      .toEqual([{ id: "return-30", name: "return-30" }]);
    // A server from before stored names sends none at all.
    expect(listingSetupSavedOption({ selection: SAVED }, "paymentPolicyId"))
      .toEqual([{ id: "managed-payments", name: "managed-payments" }]);
  });

  it("offers nothing for a policy that is not saved, whatever name is stored", () => {
    expect(listingSetupSavedOption({ selection: NOTHING_SAVED, storedNames }, "fulfillmentPolicyId")).toEqual([]);
    expect(listingSetupSavedOption({ selection: { ...SAVED, paymentPolicyId: "" }, storedNames }, "paymentPolicyId")).toEqual([]);
  });
});

describe("listingSetupRevision", () => {
  it("returns a positive whole revision as it is", () => {
    expect(listingSetupRevision({ revision: 1 })).toBe(1);
    expect(listingSetupRevision({ revision: 42 })).toBe(42);
    expect(listingSetupRevision({ revision: Number.MAX_SAFE_INTEGER })).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("returns null for an answer without a usable revision, so the page asks for a reload", () => {
    expect(listingSetupRevision({})).toBeNull();
    expect(listingSetupRevision({ revision: undefined })).toBeNull();
    expect(listingSetupRevision({ revision: null })).toBeNull();
    for (const revision of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(listingSetupRevision({ revision }), String(revision)).toBeNull();
    }
    // A revision sent as text is not trusted as a number.
    expect(listingSetupRevision({ revision: "3" as unknown as number })).toBeNull();
  });
});

describe("buildEbayListingSetupSaveRequest", () => {
  it("sends every chosen policy against the revision they were chosen at, with the request key, when nothing is saved yet", () => {
    expect(buildEbayListingSetupSaveRequest({ revision: 7, selection: NOTHING_SAVED }, DRAFT, "ebay-setup:key-0001")).toEqual({
      expectedRevision: 7,
      idempotencyKey: "ebay-setup:key-0001",
      fulfillmentPolicyId: "usps-ground",
      returnPolicyId: "return-30",
      paymentPolicyId: "managed-payments",
    });
  });

  it("sends only the policy that changed, so a return change needs no Card Shellz shipping check", () => {
    const body = buildEbayListingSetupSaveRequest(
      { revision: 7, selection: SAVED }, { ...DRAFT, returnPolicyId: "return-60" }, "ebay-setup:key-0001",
    );
    expect(body).toEqual({ expectedRevision: 7, idempotencyKey: "ebay-setup:key-0001", returnPolicyId: "return-60" });
    expect(body).not.toHaveProperty("fulfillmentPolicyId");
  });

  it("sends each changed policy and leaves the unchanged ones out", () => {
    const body = buildEbayListingSetupSaveRequest(
      { revision: 7, selection: SAVED },
      { fulfillmentPolicyId: "ups-ground", returnPolicyId: "return-30", paymentPolicyId: "other-payments" },
      "ebay-setup:key-0001",
    );
    expect(body).toEqual({
      expectedRevision: 7, idempotencyKey: "ebay-setup:key-0001",
      fulfillmentPolicyId: "ups-ground", paymentPolicyId: "other-payments",
    });
  });

  it("counts a policy picked where none was saved as a change", () => {
    const body = buildEbayListingSetupSaveRequest(
      { revision: 7, selection: { ...SAVED, paymentPolicyId: null } }, DRAFT, "ebay-setup:key-0001",
    );
    expect(body).toEqual({ expectedRevision: 7, idempotencyKey: "ebay-setup:key-0001", paymentPolicyId: "managed-payments" });
  });

  it("sends every chosen policy when nothing changed, so the server can confirm the whole selection", () => {
    expect(buildEbayListingSetupSaveRequest({ revision: 7, selection: SAVED }, DRAFT, "ebay-setup:key-0001")).toEqual({
      expectedRevision: 7,
      idempotencyKey: "ebay-setup:key-0001",
      fulfillmentPolicyId: "usps-ground",
      returnPolicyId: "return-30",
      paymentPolicyId: "managed-payments",
    });
  });

  it("never sends an empty policy, changed or not", () => {
    // A saved shipping policy eBay no longer offers opens empty: clearing is not a change to send.
    const changedReturn = buildEbayListingSetupSaveRequest(
      { revision: 7, selection: SAVED }, { ...DRAFT, fulfillmentPolicyId: "", returnPolicyId: "return-60" }, "ebay-setup:key-0001",
    );
    expect(changedReturn).toEqual({ expectedRevision: 7, idempotencyKey: "ebay-setup:key-0001", returnPolicyId: "return-60" });
    // With nothing changed, only the chosen policies are sent.
    const nothingChanged = buildEbayListingSetupSaveRequest(
      { revision: 7, selection: SAVED }, { ...DRAFT, fulfillmentPolicyId: "" }, "ebay-setup:key-0001",
    );
    expect(nothingChanged).toEqual({
      expectedRevision: 7, idempotencyKey: "ebay-setup:key-0001",
      returnPolicyId: "return-30", paymentPolicyId: "managed-payments",
    });
    // With nothing chosen at all, no policy is invented.
    const empty = { fulfillmentPolicyId: "", returnPolicyId: "", paymentPolicyId: "" };
    expect(buildEbayListingSetupSaveRequest({ revision: 7, selection: NOTHING_SAVED }, empty, "ebay-setup:key-0001"))
      .toEqual({ expectedRevision: 7, idempotencyKey: "ebay-setup:key-0001" });
  });

  it("never sends the shelf default or anything else the draft happens to carry", () => {
    const draft = { ...DRAFT, merchantLocationKey: "vendor-chosen", storeShelfDefault: { ids: ["1"] } };
    const body = buildEbayListingSetupSaveRequest({ revision: 7, selection: NOTHING_SAVED }, draft, "ebay-setup:key-0001");
    expect(Object.keys(body).sort()).toEqual([
      "expectedRevision", "fulfillmentPolicyId", "idempotencyKey", "paymentPolicyId", "returnPolicyId",
    ]);
    const unchanged = buildEbayListingSetupSaveRequest({ revision: 7, selection: SAVED }, draft, "ebay-setup:key-0001");
    expect(unchanged).not.toHaveProperty("merchantLocationKey");
    expect(unchanged).not.toHaveProperty("storeShelfDefault");
  });

  it("does not change the draft or the loaded setup it was built from", () => {
    const draft = Object.freeze({ ...DRAFT, returnPolicyId: "return-60" });
    const setup = Object.freeze({ revision: 7, selection: Object.freeze({ ...SAVED }) });
    const body = buildEbayListingSetupSaveRequest(setup, draft, "ebay-setup:key-0001");
    expect(draft).toEqual({ ...DRAFT, returnPolicyId: "return-60" });
    expect(setup).toEqual({ revision: 7, selection: SAVED });
    expect(body).not.toBe(draft);
  });

  it("refuses to build a save without a revision and tells the vendor to reload", () => {
    for (const revision of [undefined, null, 0, -3, 2.5]) {
      expect(() => buildEbayListingSetupSaveRequest({ revision, selection: SAVED }, DRAFT, "ebay-setup:key-0001"), String(revision))
        .toThrow(LISTING_SETUP_RELOAD_MESSAGE);
    }
    expect(() => buildEbayListingSetupSaveRequest({ selection: NOTHING_SAVED }, DRAFT, "ebay-setup:key-0001"))
      .toThrow(LISTING_SETUP_RELOAD_MESSAGE);
    expect(LISTING_SETUP_RELOAD_MESSAGE).toBe("This page is out of date. Reload it, then save again.");
  });
});

describe("buildEbayShipFromRepairRequest", () => {
  it("sends only the revision and the request key: the repair changes no policy", () => {
    expect(buildEbayShipFromRepairRequest({ revision: 9 }, "ebay-ship-from:key-0001")).toEqual({
      expectedRevision: 9,
      idempotencyKey: "ebay-ship-from:key-0001",
    });
  });

  it("refuses to build a repair without a revision and tells the vendor to reload", () => {
    for (const setup of [{}, { revision: null }, { revision: 0 }, { revision: Number.NaN }]) {
      expect(() => buildEbayShipFromRepairRequest(setup, "ebay-ship-from:key-0001")).toThrow(LISTING_SETUP_RELOAD_MESSAGE);
    }
  });
});

describe("ListingSetupRequestKeys", () => {
  function counterKeys(prefix = "ebay-setup") {
    let issued = 0;
    const newKey = vi.fn((keyPrefix: string) => `${keyPrefix}:key-${String(++issued).padStart(4, "0")}`);
    return { keys: new ListingSetupRequestKeys(prefix, newKey), newKey };
  }

  it("reuses the key for a retry of the same choices against the same revision", () => {
    const { keys, newKey } = counterKeys();
    const first = keys.keyFor({ revision: 3, draft: DRAFT });
    // A new object with the same content is the same attempt (a retry after a lost answer).
    const retry = keys.keyFor({ revision: 3, draft: { ...DRAFT } });
    expect(first).toBe("ebay-setup:key-0001");
    expect(retry).toBe(first);
    expect(newKey).toHaveBeenCalledOnce();
    expect(newKey).toHaveBeenCalledWith("ebay-setup");
  });

  it("starts a new attempt with a new key when the choices or the revision change", () => {
    const { keys } = counterKeys();
    const first = keys.keyFor({ revision: 3, draft: DRAFT });
    const otherPolicy = keys.keyFor({ revision: 3, draft: { ...DRAFT, returnPolicyId: "return-60" } });
    const otherRevision = keys.keyFor({ revision: 4, draft: { ...DRAFT, returnPolicyId: "return-60" } });
    expect(new Set([first, otherPolicy, otherRevision]).size).toBe(3);
  });

  it("remembers only the current attempt, so going back to earlier choices is a new attempt", () => {
    // The earlier choices may already be saved; reusing their key would replay
    // that save instead of saving what the vendor now asks for.
    const { keys } = counterKeys();
    const a = keys.keyFor({ revision: 3, draft: DRAFT });
    keys.keyFor({ revision: 3, draft: { ...DRAFT, paymentPolicyId: "other-payments" } });
    const aAgain = keys.keyFor({ revision: 3, draft: DRAFT });
    expect(aAgain).not.toBe(a);
    expect(aAgain).toBe("ebay-setup:key-0003");
  });

  it("gives the next save a new key once the server confirmed the last one", () => {
    const { keys, newKey } = counterKeys();
    const saved = keys.keyFor({ revision: 3, draft: DRAFT });
    keys.settled();
    const next = keys.keyFor({ revision: 3, draft: DRAFT });
    expect(next).not.toBe(saved);
    expect(newKey).toHaveBeenCalledTimes(2);
  });

  it("settling with no attempt in progress is harmless", () => {
    const { keys } = counterKeys();
    keys.settled();
    expect(keys.keyFor({ revision: 1 })).toBe("ebay-setup:key-0001");
  });

  it("keeps the save and the ship-from repair keys apart", () => {
    let issued = 0;
    const newKey = (prefix: string) => `${prefix}:key-${String(++issued).padStart(4, "0")}`;
    const save = new ListingSetupRequestKeys("ebay-setup", newKey);
    const repair = new ListingSetupRequestKeys("ebay-ship-from", newKey);
    const saveKey = save.keyFor({ revision: 3 });
    const repairKey = repair.keyFor({ revision: 3 });
    expect(saveKey).toBe("ebay-setup:key-0001");
    expect(repairKey).toBe("ebay-ship-from:key-0002");
    expect(save.keyFor({ revision: 3 })).toBe(saveKey);
  });

  it("by default makes a prefixed key the server accepts", () => {
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
    const keys = new ListingSetupRequestKeys("ebay-setup");
    const key = keys.keyFor({ revision: 3, draft: DRAFT });
    expect(key).toBe("ebay-setup:00000000-0000-4000-8000-000000000001");
    expect(key).toMatch(SERVER_REQUEST_KEY);
    expect(keys.keyFor({ revision: 3, draft: DRAFT })).toBe(key);
  });
});

describe("listingSetupSaveErrorMessage", () => {
  function apiError(code: string, message = "Server words.", status = 409) {
    return new DropshipApiError({ status, code, message });
  }

  it.each([
    {
      // The reload keeps the vendor's picks (EbayListingSetupPanel, rebaseEbayListingSetupDraft), so the words say so.
      code: "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT",
      message: "These settings changed in another window. Choose Refresh options to load what is saved now. Your changes stay chosen; check them, then save again.",
    },
    {
      code: "DROPSHIP_EBAY_FULFILLMENT_MARKETPLACE_UNSUPPORTED",
      message: "Card Shellz lists on eBay US only. This store is set up for another eBay site. Contact support.",
    },
    { code: "DROPSHIP_LISTING_CONFIG_REVISION_REQUIRED", message: LISTING_SETUP_RELOAD_MESSAGE },
    {
      code: "DROPSHIP_STORE_CONNECTION_NOT_CONNECTED",
      message: "This store is paused or disconnected, so its settings can't be changed now.",
    },
    { code: "DROPSHIP_EBAY_LISTING_SETUP_RATE_LIMITED", message: "Too many saves in a minute. Wait a moment and try again." },
    {
      code: "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTED",
      message: "This store is disconnected, so its settings can't be changed now.",
    },
  ])("says what to do about $code in the panel's words", ({ code, message }) => {
    expect(listingSetupSaveErrorMessage(apiError(code), "fallback")).toBe(message);
  });

  it("tells a ship-from repair that hit a revision conflict to update the ship-from location again", () => {
    // The repair changes no policy, so there are no changes to keep; the vendor reloads, then repairs again.
    const conflict = apiError("DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT");
    const repairWords = "These settings changed in another window. Choose Refresh options, then Update ship-from location again.";
    expect(listingSetupSaveErrorMessage(conflict, "The ship-from location could not be updated.", "ship_from_repair")).toBe(repairWords);
    expect(repairWords).not.toContain("save again");
  });

  it("keeps the save's revision conflict words when the action is left out or is the save", () => {
    const conflict = apiError("DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT");
    const saveWords = "These settings changed in another window. Choose Refresh options to load what is saved now. Your changes stay chosen; check them, then save again.";
    expect(listingSetupSaveErrorMessage(conflict, "fallback")).toBe(saveWords);
    expect(listingSetupSaveErrorMessage(conflict, "fallback", "save")).toBe(saveWords);
    expect(listingSetupSaveErrorMessage(conflict, "fallback", "save")).not.toContain("Update ship-from location");
  });

  it("gives a ship-from repair the same words as a save for every other refusal", () => {
    for (const code of [
      "DROPSHIP_EBAY_FULFILLMENT_MARKETPLACE_UNSUPPORTED",
      "DROPSHIP_LISTING_CONFIG_REVISION_REQUIRED",
      "DROPSHIP_STORE_CONNECTION_NOT_CONNECTED",
      "DROPSHIP_EBAY_LISTING_SETUP_RATE_LIMITED",
      "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTED",
      "DROPSHIP_EBAY_MANAGED_LOCATION_WAREHOUSE_REQUIRED",
      "DROPSHIP_LISTING_CONFIG_STORE_PAUSED",
    ]) {
      expect(listingSetupSaveErrorMessage(apiError(code), "fallback", "ship_from_repair"), code)
        .toBe(listingSetupSaveErrorMessage(apiError(code), "fallback"));
    }
    expect(listingSetupSaveErrorMessage(null, "The ship-from location could not be updated.", "ship_from_repair"))
      .toBe("The ship-from location could not be updated.");
  });

  it("keeps the server's own words for any other refusal", () => {
    const paused = apiError("DROPSHIP_LISTING_CONFIG_STORE_PAUSED",
      "This store is paused, so its listing settings can't be changed now.");
    expect(listingSetupSaveErrorMessage(paused, "fallback")).toBe("This store is paused, so its listing settings can't be changed now.");
    const shelf = apiError("DROPSHIP_EBAY_STORE_SHELF_DEFAULT_INVALID",
      "That shelf is not in your eBay store anymore. Choose another shelf.", 400);
    expect(listingSetupSaveErrorMessage(shelf, "fallback")).toBe("That shelf is not in your eBay store anymore. Choose another shelf.");
    expect(listingSetupSaveErrorMessage(new Error("Network request failed"), "fallback")).toBe("Network request failed");
  });

  it("falls back when the error says nothing usable", () => {
    expect(listingSetupSaveErrorMessage(new Error(""), "eBay listing setup could not be saved."))
      .toBe("eBay listing setup could not be saved.");
    expect(listingSetupSaveErrorMessage("offline", "eBay listing setup could not be saved."))
      .toBe("eBay listing setup could not be saved.");
    expect(listingSetupSaveErrorMessage(null, "The ship-from location could not be updated."))
      .toBe("The ship-from location could not be updated.");
    expect(listingSetupSaveErrorMessage(apiError("SOMETHING_NEW", ""), "fallback")).toBe("fallback");
  });

  it("maps a code only from a server refusal, not from a plain error that mentions it", () => {
    const plain = new Error("DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT");
    expect(listingSetupSaveErrorMessage(plain, "fallback")).toBe("DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT");
    const shipping = new Error("DROPSHIP_EBAY_FULFILLMENT_ROUTING_REQUIRED");
    expect(listingSetupSaveErrorMessage(shipping, "fallback")).toBe("DROPSHIP_EBAY_FULFILLMENT_ROUTING_REQUIRED");
  });

  describe("shipping refusals the vendor fixes themselves", () => {
    const INCOMPATIBLE = "DROPSHIP_EBAY_FULFILLMENT_POLICY_INCOMPATIBLE";
    const MARKETPLACE = "DROPSHIP_EBAY_FULFILLMENT_MARKETPLACE_UNSUPPORTED";
    const DOES_NOT_FIT = "This shipping policy doesn't work with Card Shellz shipping. Choose Refresh options, then pick another shipping policy.";
    const US_ONLY = "Card Shellz lists on eBay US only. This store is set up for another eBay site. Contact support.";

    function refusal(code: string, context: Record<string, unknown> | null, message = "Server words for staff.") {
      return new DropshipApiError({ status: code === INCOMPATIBLE ? 422 : 409, code, context, message });
    }

    it("names the first reason the server gave for a shipping policy that doesn't fit", () => {
      // The server sends the policy's compatibility issues as context.issues
      // (dropship-ebay-listing-setup-service.ts, DROPSHIP_EBAY_FULFILLMENT_POLICY_INCOMPATIBLE).
      const message = listingSetupSaveErrorMessage(refusal(INCOMPATIBLE, { retryable: false, fulfillmentPolicyId: "usps-ground", issues: [
        { code: "local_pickup_unsupported", message: "Local pickup is not offered" },
        { code: "freight_shipping_unsupported", message: "Freight shipping is not offered" },
      ] }, "The selected eBay fulfillment policy exceeds Card Shellz fulfillment capabilities."), "fallback");
      expect(message).toBe(
        "This shipping policy doesn't work with Card Shellz shipping: Local pickup is not offered. Choose Refresh options, then pick another shipping policy.",
      );
      expect(message).not.toContain("Freight");
      expect(message).not.toContain("exceeds Card Shellz fulfillment capabilities");
    });

    it("says the policy doesn't fit, without a reason, when the server named none", () => {
      for (const context of [null, {}, { issues: [] }, { issues: "Local pickup is not offered" }, { issues: { message: "Local pickup" } }]) {
        expect(listingSetupSaveErrorMessage(refusal(INCOMPATIBLE, context), "fallback"), JSON.stringify(context)).toBe(DOES_NOT_FIT);
      }
    });

    it("skips issues whose message is blank or not text, and trims the one it uses", () => {
      const message = listingSetupSaveErrorMessage(refusal(INCOMPATIBLE, { issues: [
        null, "A bare string issue", 7, [], { code: "no_message" }, { message: 42 }, { message: null }, { message: "" }, { message: "   " },
        { code: "handling_time_too_short", message: "  Handling time is too short \n" },
        { code: "later", message: "A later issue" },
      ] }), "fallback");
      expect(message).toBe(
        "This shipping policy doesn't work with Card Shellz shipping: Handling time is too short. Choose Refresh options, then pick another shipping policy.",
      );
      expect(message).not.toContain("A bare string issue");
      // Nothing usable at all: no reason is invented and no empty one is printed.
      const onlyBlank = listingSetupSaveErrorMessage(refusal(INCOMPATIBLE, { issues: [{ message: " " }, { message: undefined }, false] }), "fallback");
      expect(onlyBlank).toBe(DOES_NOT_FIT);
      expect(onlyBlank).not.toContain(": .");
    });

    it.each([
      "Local pickup is not offered.",
      "Local pickup is not offered...",
      "Local pickup is not offered. ",
      "Local pickup is not offered . . \n",
      "  Local pickup is not offered.\t.",
    ])("ends the sentence with exactly one period when the issue %j already ends with periods or spaces", (issue) => {
      const message = listingSetupSaveErrorMessage(refusal(INCOMPATIBLE, { issues: [{ message: issue }] }), "fallback");
      expect(message).toBe(
        "This shipping policy doesn't work with Card Shellz shipping: Local pickup is not offered. Choose Refresh options, then pick another shipping policy.",
      );
      expect(message).not.toMatch(/\.\s*\./);
    });

    it("keeps the periods inside an issue and strips only the trailing ones", () => {
      const message = listingSetupSaveErrorMessage(refusal(INCOMPATIBLE, { issues: [{ message: "Ships to the U.S. only." }] }), "fallback");
      expect(message).toBe(
        "This shipping policy doesn't work with Card Shellz shipping: Ships to the U.S. only. Choose Refresh options, then pick another shipping policy.",
      );
    });

    it("prints no issue that is only periods and spaces, and uses the next one that says something", () => {
      for (const issue of [".", "...", " . . ", ".\n."]) {
        const message = listingSetupSaveErrorMessage(refusal(INCOMPATIBLE, { issues: [{ message: issue }] }), "fallback");
        expect(message, JSON.stringify(issue)).toBe(DOES_NOT_FIT);
        expect(message).not.toContain(": ");
      }
      const next = listingSetupSaveErrorMessage(refusal(INCOMPATIBLE, { issues: [
        { message: "..." }, { message: "Freight shipping is not offered." },
      ] }), "fallback");
      expect(next).toBe(
        "This shipping policy doesn't work with Card Shellz shipping: Freight shipping is not offered. Choose Refresh options, then pick another shipping policy.",
      );
    });

    it("tells a store on another eBay site to contact support, in the same words as the shipping-check notice", () => {
      const message = listingSetupSaveErrorMessage(
        refusal(MARKETPLACE, { retryable: false, issues: [{ message: "Policy is for EBAY_GB" }] }, "Marketplace EBAY_GB is not supported."),
        "fallback",
      );
      expect(message).toBe(US_ONLY);
      expect(message).toBe(listingSetupShippingCheckNotice({ checks: { ebay: "checked", fulfillment: {
        status: "unavailable", reference: MARKETPLACE, kind: "marketplace_unsupported",
      } } })?.message);
    });

    it.each([
      { code: INCOMPATIBLE, words: DOES_NOT_FIT },
      { code: MARKETPLACE, words: US_ONLY },
    ])("never gives $code the Card Shellz finishing-setup or try-again words, retryable or not", ({ code, words }) => {
      // Both codes start with DROPSHIP_EBAY_FULFILLMENT_, the prefix of Card Shellz's own shipping problems.
      for (const context of [null, {}, { retryable: false }, { retryable: true }]) {
        const message = listingSetupSaveErrorMessage(refusal(code, context), "fallback");
        expect(message, JSON.stringify(context)).toBe(words);
        expect(message).not.toContain("finishing shipping setup");
        expect(message).not.toContain("Can't check Card Shellz shipping right now");
        expect(message).not.toContain("Reference:");
        expect(message).not.toContain("DROPSHIP_");
      }
    });

    it("maps these codes only from a server refusal, not from a plain error that mentions them", () => {
      expect(listingSetupSaveErrorMessage(new Error(INCOMPATIBLE), "fallback")).toBe(INCOMPATIBLE);
      expect(listingSetupSaveErrorMessage(new Error(MARKETPLACE), "fallback")).toBe(MARKETPLACE);
    });

    it("reads the reason from the server's error body", async () => {
      // The whole client path: the PUT's 422 body, through fetch, to the panel's words.
      vi.stubGlobal("fetch", vi.fn(async () => ({
        ok: false,
        status: 422,
        statusText: "Unprocessable Entity",
        json: async () => ({ error: {
          code: INCOMPATIBLE,
          message: "The selected eBay fulfillment policy exceeds Card Shellz fulfillment capabilities.",
          context: { storeConnectionId: 44, fulfillmentPolicyId: "usps-ground", retryable: false,
            issues: [{ code: "local_pickup_unsupported", message: "Local pickup is not offered" }] },
        } }),
      }) as Response));
      const caught = await putJson("/api/dropship/ebay/listing-setup/44", { expectedRevision: 3 }).catch((error: unknown) => error);
      expect(listingSetupSaveErrorMessage(caught, "fallback")).toBe(
        "This shipping policy doesn't work with Card Shellz shipping: Local pickup is not offered. Choose Refresh options, then pick another shipping policy.",
      );
    });
  });

  describe("Card Shellz shipping and warehouse refusals", () => {
    function shippingError(code: string, context: Record<string, unknown> | null) {
      return new DropshipApiError({
        status: 409, code, context,
        message: "Fulfillment routing for channel 103 has no rate table for service level 7.",
      });
    }

    it.each([
      "DROPSHIP_EBAY_FULFILLMENT_ROUTING_REQUIRED",
      "DROPSHIP_EBAY_FULFILLMENT_NO_RATE_BOOK",
      "DROPSHIP_EBAY_MANAGED_LOCATION_WAREHOUSE_ADDRESS_REQUIRED",
      "DROPSHIP_EBAY_MANAGED_LOCATION_WAREHOUSE_REQUIRED",
      "DROPSHIP_EBAY_MANAGED_LOCATION_COUNTRY_UNSUPPORTED",
    ])("gives the vendor plain words and %s as the reference, never the staff wording", (code) => {
      const message = listingSetupSaveErrorMessage(shippingError(code, { retryable: false }), "fallback");
      expect(message).toBe(`Card Shellz is finishing shipping setup for your store, so this can't be saved yet. Reference: ${code}`);
      expect(message).not.toContain("rate table");
    });

    it("asks the vendor to try again in a few minutes when the server says the refusal is retryable", () => {
      const code = "DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE";
      expect(listingSetupSaveErrorMessage(shippingError(code, { retryable: true }), "fallback"))
        .toBe(`Can't check Card Shellz shipping right now. Try again in a few minutes. Reference: ${code}`);
    });

    it("uses the finishing-setup words unless retryable is exactly true", () => {
      const code = "DROPSHIP_EBAY_FULFILLMENT_SHIPSTATION_UNAVAILABLE";
      const finishing = `Card Shellz is finishing shipping setup for your store, so this can't be saved yet. Reference: ${code}`;
      for (const context of [null, {}, { retryable: "true" }, { retryable: 1 }, { retryable: false }]) {
        expect(listingSetupSaveErrorMessage(shippingError(code, context), "fallback"), JSON.stringify(context)).toBe(finishing);
      }
    });

    it("keeps the server's words for an eBay location code that is not about the Card Shellz warehouse", () => {
      const mismatch = new DropshipApiError({
        status: 409, code: "DROPSHIP_EBAY_MANAGED_LOCATION_CONFIG_MISMATCH",
        message: "Card Shellz needs to update where your eBay listings ship from.",
      });
      expect(listingSetupSaveErrorMessage(mismatch, "fallback")).toBe("Card Shellz needs to update where your eBay listings ship from.");
      // The code must start with the prefix, not merely contain it.
      const nested = new DropshipApiError({
        status: 409, code: "X_DROPSHIP_EBAY_FULFILLMENT_ROUTING_REQUIRED", message: "Server words.",
      });
      expect(listingSetupSaveErrorMessage(nested, "fallback")).toBe("Server words.");
    });

    it("maps a retryable refusal read from the server's error body", async () => {
      // The whole client path: the PUT's error body, through fetch, to the panel's words.
      vi.stubGlobal("fetch", vi.fn(async () => ({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        json: async () => ({ error: {
          code: "DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE",
          message: "Fulfillment routing lookup timed out after 3 attempts.",
          context: { storeConnectionId: 44, retryable: true },
        } }),
      }) as Response));
      const caught = await putJson("/api/dropship/ebay/listing-setup/44", { expectedRevision: 3 }).catch((error: unknown) => error);
      expect(listingSetupSaveErrorMessage(caught, "fallback")).toBe(
        "Can't check Card Shellz shipping right now. Try again in a few minutes. Reference: DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE",
      );
    });
  });
});

