import { describe, expect, it, vi } from "vitest";
import { z, ZodError } from "zod";
import type { DropshipListingStoreContext } from "../../application/dropship-listing-preview-service";
import {
  LISTING_SETTING_INVALID_INPUT_MESSAGE,
  MAX_ECHOED_ISSUES,
  assertListingSettingMember,
  authorizeListingSettingWrite,
  listingSettingIssues,
  listingSettingKeyConflict,
  listingSettingStoreIdSchema,
  listingSettingWriteHash,
  parseListingSettingInput,
  requestKeyUsePath,
} from "../../application/dropship-listing-setting-write-support";
import type { ListingSettingWriteTransaction } from "../../application/dropship-listing-setting-writes";
import { DropshipError } from "../../domain/errors";
import { listingSettingRequestHash } from "../../domain/listing-setting-values";

const STORE = 22;
const VENDOR = 10;
const context: DropshipListingStoreContext = Object.freeze({
  vendorId: VENDOR, vendorStatus: "active", entitlementStatus: "active", storeConnectionId: STORE, storeStatus: "connected",
  setupStatus: "ready", platform: "ebay", storeLaunchReady: true,
});

function txWith(found: DropshipListingStoreContext | null) {
  const loadStoreContext = vi.fn(async () => found);
  const tx = { vendorId: VENDOR, storeConnectionId: STORE, catalog: { loadStoreContext } } as unknown as
    Pick<ListingSettingWriteTransaction, "vendorId" | "storeConnectionId" | "catalog">;
  return { tx, loadStoreContext };
}

async function refusal(promise: Promise<unknown>): Promise<DropshipError> {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(DropshipError);
  return error as DropshipError;
}

describe("authorizeListingSettingWrite (plan PR 9, P10, section 3.8)", () => {
  it("reads the owner's store context once and answers it when every check passes", async () => {
    const { tx, loadStoreContext } = txWith(context);
    await expect(authorizeListingSettingWrite(tx)).resolves.toEqual(context);
    expect(loadStoreContext).toHaveBeenCalledExactlyOnceWith({ vendorId: VENDOR, storeConnectionId: STORE });
  });

  it.each([
    ["onboarding vendor", { vendorStatus: "onboarding" }],
    ["store that needs a sign-in", { storeStatus: "needs_reauth" }],
    ["store whose token refresh failed", { storeStatus: "refresh_failed" }],
  ])("allows an %s", async (_label, fields) => {
    const { tx } = txWith({ ...context, ...fields } as DropshipListingStoreContext);
    await expect(authorizeListingSettingWrite(tx)).resolves.toMatchObject(fields);
  });

  it.each([
    ["no store", null, "DROPSHIP_STORE_CONNECTION_REQUIRED", undefined],
    ["a suspended vendor", { ...context, vendorStatus: "suspended" }, "DROPSHIP_LISTING_VENDOR_BLOCKED", "suspended"],
    ["a closed vendor", { ...context, vendorStatus: "closed" }, "DROPSHIP_LISTING_VENDOR_BLOCKED", "closed"],
    ["a lapsed .ops entitlement", { ...context, entitlementStatus: "lapsed" }, "DROPSHIP_LISTING_ENTITLEMENT_BLOCKED", "lapsed"],
    ["a paused store", { ...context, storeStatus: "paused" }, "DROPSHIP_LISTING_STORE_BLOCKED", "paused"],
    ["a disconnected store", { ...context, storeStatus: "disconnected" }, "DROPSHIP_LISTING_STORE_BLOCKED", "disconnected"],
    ["a store not on eBay", { ...context, platform: "shopify" }, "DROPSHIP_LISTING_SETTINGS_EBAY_ONLY", undefined],
  ])("refuses %s, permanently", async (_label, found, code, reason) => {
    const error = await refusal(authorizeListingSettingWrite(txWith(found as DropshipListingStoreContext | null).tx));
    expect(error.code).toBe(code);
    expect(error.context).toEqual({ storeConnectionId: STORE, ...(reason ? { reason } : {}), retryable: false, classification: "permanent" });
  });

  it("refuses in order: vendor before entitlement before store status before platform", async () => {
    const everything: DropshipListingStoreContext = { ...context, vendorStatus: "suspended", entitlementStatus: "lapsed",
      storeStatus: "paused", platform: "shopify" };
    expect((await refusal(authorizeListingSettingWrite(txWith(everything).tx))).code).toBe("DROPSHIP_LISTING_VENDOR_BLOCKED");
    expect((await refusal(authorizeListingSettingWrite(txWith({ ...everything, vendorStatus: "active" }).tx))).code)
      .toBe("DROPSHIP_LISTING_ENTITLEMENT_BLOCKED");
    expect((await refusal(authorizeListingSettingWrite(txWith({ ...everything, vendorStatus: "active", entitlementStatus: "active" }).tx))).code)
      .toBe("DROPSHIP_LISTING_STORE_BLOCKED");
    expect((await refusal(authorizeListingSettingWrite(txWith({ ...context, platform: "shopify" }).tx))).code)
      .toBe("DROPSHIP_LISTING_SETTINGS_EBAY_ONLY");
  });
});

describe("the request hash and the replay path", () => {
  it("hashes the operation and the parsed body, and never a request key", () => {
    const body = Object.freeze({ storeConnectionId: STORE, rows: Object.freeze([Object.freeze({ productVariantId: 1, priceCents: 1, expectedRevisionId: null })]) });
    expect(listingSettingWriteHash("size_prices_v1", body)).toBe(listingSettingRequestHash({ operation: "size_prices_v1", ...body }));
    expect(listingSettingWriteHash("size_prices_v1", body)).not.toBe(listingSettingWriteHash("size_prices_v2", body));
    expect(() => listingSettingWriteHash("size_prices_v1", { ...body, idempotencyKey: "listing:abcdefgh" }))
      .toThrow(expect.objectContaining({ code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED" }));
  });

  it("takes new and replay as they are, and turns a conflict and an incomplete replay into their errors", () => {
    expect(requestKeyUsePath({ kind: "new" }, { storeConnectionId: STORE })).toBe("new");
    expect(requestKeyUsePath({ kind: "replay" }, { storeConnectionId: STORE })).toBe("replay");
    expect(() => requestKeyUsePath({ kind: "conflict", mismatched: ["size.requestHash"] }, { storeConnectionId: STORE }))
      .toThrow(expect.objectContaining({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT",
        context: { storeConnectionId: STORE, mismatched: ["size.requestHash"], retryable: false, classification: "permanent" } }));
    expect(() => requestKeyUsePath({ kind: "incomplete" }, { storeConnectionId: STORE }))
      .toThrow(expect.objectContaining({ code: "DROPSHIP_LISTING_SETTINGS_REPLAY_INCOMPLETE",
        context: { storeConnectionId: STORE, retryable: false, classification: "fatal" } }));
  });

  it("words a key conflict as the 8a writers do, and copies the mismatched list", () => {
    const mismatched = ["ledger.operation"];
    const error = listingSettingKeyConflict(mismatched, { storeConnectionId: STORE });
    expect(error.message).toBe("This request key was already used for a different listing settings change.");
    mismatched.push("changed later");
    expect(error.context?.mismatched).toEqual(["ledger.operation"]);
  });

  it("refuses a blank member as authentication required", () => {
    expect(() => assertListingSettingMember(" ")).toThrow(expect.objectContaining({ code: "DROPSHIP_AUTH_REQUIRED" }));
    expect(() => assertListingSettingMember("member-1")).not.toThrow();
  });
});

describe("the route input parser and its issues (plan P5)", () => {
  it("returns the parsed value, and refuses bad input as the permanent 400 code with the issues, never a bare ZodError", () => {
    expect(parseListingSettingInput(listingSettingStoreIdSchema, 22)).toBe(22);
    let thrown: unknown = null;
    try { parseListingSettingInput(listingSettingStoreIdSchema, Number.NaN); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(DropshipError);
    expect(thrown).not.toBeInstanceOf(ZodError);
    expect(thrown).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_INVALID_INPUT", message: LISTING_SETTING_INVALID_INPUT_MESSAGE,
      context: { issues: [{ path: [], code: "invalid_type" }], retryable: false, classification: "permanent" } });
  });

  it("keeps at most 20 issues, each { path, code }, with a message only on a custom issue, and never mutates its input", () => {
    const schema = z.object({ rows: z.array(z.object({ name: z.enum(["a", "b"]) })) }).refine(() => false, "Each size once.");
    const parsed = schema.safeParse({ rows: Array.from({ length: 30 }, () => ({ name: "vendor secret text" })) });
    expect(parsed.success).toBe(false);
    const issues = Object.freeze([...parsed.error!.issues]);

    const echoed = listingSettingIssues(issues);

    expect(echoed).toHaveLength(MAX_ECHOED_ISSUES);
    expect(echoed[0]).toEqual({ path: ["rows", 0, "name"], code: "invalid_enum_value" });
    expect(JSON.stringify(echoed)).not.toContain("vendor secret text");
    expect(listingSettingIssues([{ code: "custom", path: ["rows"], message: "Each size once." }]))
      .toEqual([{ path: ["rows"], code: "custom", message: "Each size once." }]);
    // 8a's writers report a dotted path; a record without a code or a path is not an issue.
    expect(listingSettingIssues([{ path: "rows.0.priceCents", code: "too_small" }, { path: ["x"] }, { code: "custom" }, 7]))
      .toEqual([{ path: "rows.0.priceCents", code: "too_small" }]);
  });
});
