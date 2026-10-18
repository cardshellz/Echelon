import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DropshipApiError,
  putJson,
  type DropshipEbayListingSetupFulfillmentCheck,
} from "../dropship-ops-surface";
import {
  LISTING_SETUP_RELOAD_MESSAGE,
  listingSetupRevision,
  listingSetupSaveErrorMessage,
  listingSetupShippingCheckNotice,
} from "../dropship-ebay-listing-setup";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

describe("listingSetupSaveErrorMessage", () => {
  function apiError(code: string, message = "Server words.", status = 409) {
    return new DropshipApiError({ status, code, message });
  }

  it.each([
    {
      // The words say the vendor's picks stay chosen over the reload.
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
  ])("says what to do about $code in plain words", ({ code, message }) => {
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
      // The whole client path: the PUT's 422 body, through fetch, to the vendor's words.
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
      // The whole client path: the PUT's error body, through fetch, to the vendor's words.
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

