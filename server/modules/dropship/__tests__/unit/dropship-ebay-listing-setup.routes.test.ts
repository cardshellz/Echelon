import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DropshipEbayFulfillmentUnavailableKind,
  DropshipEbayListingSetupResult,
  DropshipEbayListingSetupService,
  DropshipEbayListingSetupWriteResult,
} from "../../application/dropship-ebay-listing-setup-service";
import { DropshipError } from "../../domain/errors";
import {
  LISTING_SETUP_WRITES_PER_MINUTE,
  registerDropshipEbayListingSetupRoutes,
} from "../../interfaces/http/dropship-ebay-listing-setup.routes";

vi.mock("../../../../db", () => ({ db: {}, pool: {} }));
vi.mock("../../infrastructure/dropship-ebay-listing-setup.factory", () => ({
  createDropshipEbayListingSetupServiceFromEnv: vi.fn(),
}));

const SETUP_PATH = "/api/dropship/ebay/listing-setup/44";
const REPAIR_PATH = `${SETUP_PATH}/ship-from/repair`;
/** The test session reads the member from this header so one app can serve two members. */
const MEMBER_HEADER = "x-test-member-id";
const REQUEST_KEY = "setup-save:44:0001";
/**
 * What a page built with this release sends on the setup read (the client's
 * EBAY_LISTING_SETUP_CONTRACT_HEADERS). Spelled out here, not imported, so
 * the wire contract itself is pinned.
 */
const CONTRACT_HEADERS: Readonly<Record<string, string>> = { "X-Dropship-Listing-Setup-Contract": "2" };

describe("dropship eBay listing setup routes", () => {
  let service: FakeService;
  let server: Awaited<ReturnType<typeof startServer>> | null;

  beforeEach(() => {
    service = new FakeService();
    server = null;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server?.close();
  });

  describe("GET setup", () => {
    it("loads the read-only view for the authenticated member-owned store when the page sends the setup contract", async () => {
      server = await startServer(buildApp(service, true));

      const response = await getSetup(server.url, CONTRACT_HEADERS);

      expect(response.status).toBe(200);
      expect(service.calls).toEqual([
        { method: "getViewForMember", memberId: "member-1", storeConnectionId: 44 },
      ]);
      expect(response.body).toEqual(JSON.parse(JSON.stringify(viewResult())));
    });

    it.each(["0", "-3", "1.5", "abc"])("rejects store connection id %s before invoking the service", async (id) => {
      server = await startServer(buildApp(service, true));

      const response = await jsonRequest(`${server.url}/api/dropship/ebay/listing-setup/${id}`);

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ error: { code: "DROPSHIP_EBAY_LISTING_SETUP_INVALID_INPUT" } });
      expect(service.calls).toEqual([]);
    });

    it.each(["DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED", "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_DENIED"])("returns %s without leaking provider bodies", async (code) => {
      service.getError = new DropshipError(
        code,
        "eBay did not grant the required access.",
        {
          storeConnectionId: 44,
          resource: "paymentPolicies",
          status: 403,
          retryable: false,
          body: "provider-secret-diagnostic",
        },
      );
      server = await startServer(buildApp(service, true));

      const response = await jsonRequest(`${server.url}${SETUP_PATH}`);

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({
        error: {
          code,
          context: {
            storeConnectionId: 44,
            resource: "paymentPolicies",
            status: 403,
            retryable: false,
          },
        },
      });
      expect(JSON.stringify(response.body)).not.toContain("provider-secret-diagnostic");
    });

    it.each([
      "DROPSHIP_EBAY_REFRESH_LOCK_UNAVAILABLE",
      "DROPSHIP_CREDENTIAL_CHANGED",
      "DROPSHIP_EBAY_TOKEN_REFRESH_INVALID_RESPONSE",
    ])("returns availability status for transient token owner failure %s", async (code) => {
      service.getError = new DropshipError(code, "eBay token recovery could not finish.", { retryable: true });
      server = await startServer(buildApp(service, true));
      const response = await jsonRequest(`${server.url}${SETUP_PATH}`);
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({ error: { code, context: { retryable: true } } });
    });

    it("returns an actionable conflict when the managed warehouse address is incomplete", async () => {
      service.getError = new DropshipError(
        "DROPSHIP_EBAY_MANAGED_LOCATION_WAREHOUSE_ADDRESS_REQUIRED",
        "The dropship origin warehouse is missing eBay location address data.",
        { originWarehouseId: 1, field: "postalCode", retryable: false },
      );
      server = await startServer(buildApp(service, true));

      const response = await jsonRequest(`${server.url}${SETUP_PATH}`);

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        error: {
          code: "DROPSHIP_EBAY_MANAGED_LOCATION_WAREHOUSE_ADDRESS_REQUIRED",
          context: { originWarehouseId: 1, field: "postalCode", retryable: false },
        },
      });
    });

    it("returns an actionable conflict when Standard Shipping routing is not configured", async () => {
      service.getError = new DropshipError(
        "DROPSHIP_EBAY_FULFILLMENT_ROUTING_REQUIRED",
        "Standard Shipping needs at least one allowed domestic fulfillment method before eBay policies can be validated.",
        {
          serviceLevelId: 7,
          routingCode: "SHIPPING_FULFILLMENT_ROUTING_PROFILE_NOT_CONFIGURED",
          routingRevision: 0,
          retryable: false,
        },
      );
      server = await startServer(buildApp(service, true));

      const response = await jsonRequest(`${server.url}${SETUP_PATH}`);

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        error: {
          code: "DROPSHIP_EBAY_FULFILLMENT_ROUTING_REQUIRED",
          context: {
            serviceLevelId: 7,
            routingCode: "SHIPPING_FULFILLMENT_ROUTING_PROFILE_NOT_CONFIGURED",
            routingRevision: 0,
            retryable: false,
          },
        },
      });
    });
  });

  describe("GET setup contract (pages loaded before this release)", () => {
    it.each([
      ["a read-only view", () => viewResult()],
      ["a temporarily unavailable shipping check", () => unavailableViewResult("DROPSHIP_EBAY_FULFILLMENT_SHIPSTATION_UNAVAILABLE", "temporary")],
      ["a shipping check waiting on Card Shellz setup", () => unavailableViewResult("DROPSHIP_EBAY_FULFILLMENT_ROUTING_REQUIRED", "setup_incomplete")],
      ["a shipping check on an unsupported eBay site", () => unavailableViewResult("DROPSHIP_EBAY_FULFILLMENT_MARKETPLACE_UNSUPPORTED", "marketplace_unsupported")],
    ])("answers %s as 200 with the whole view when the page sends contract 2", async (_label, view) => {
      service.view = view();
      server = await startServer(buildApp(service, true));

      const response = await getSetup(server.url, CONTRACT_HEADERS);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(JSON.parse(JSON.stringify(view())));
    });

    it("reads the contract header name without regard to case", async () => {
      server = await startServer(buildApp(service, true));

      const response = await getSetup(server.url, { "x-dropship-listing-setup-contract": "2" });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ access: { canEdit: false, reason: "store_paused" } });
    });

    it.each([
      ["store_paused", 409, "DROPSHIP_LISTING_CONFIG_STORE_PAUSED", "This store is paused, so its listing settings can't be changed now.", { status: "paused" }],
      ["store_disconnecting", 409, "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTING", "This store is being disconnected, so its listing settings can't be changed now.", { status: "grace_period" }],
      ["store_disconnected", 409, "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTED", "Disconnected store connections cannot be updated for dropship listing configuration.", { status: "disconnected" }],
      ["vendor_not_active", 403, "DROPSHIP_LISTING_CONFIG_VENDOR_BLOCKED", "Dropship vendor status does not allow listing configuration changes.", {}],
    ] as const)("answers a read-only view (%s) without the contract header with the store status error (%i)", async (reason, status, code, message, statusContext) => {
      service.view = { ...viewResult(), access: { canEdit: false, reason } };
      server = await startServer(buildApp(service, true));

      const response = await getSetup(server.url);

      expect(response.status).toBe(status);
      // The old page's answer for this state before the release: only the
      // refusal, never the view it cannot draw.
      expect(response.body).toEqual({
        error: { code, message, context: { storeConnectionId: 44, ...statusContext, retryable: false } },
      });
      expect(service.calls).toEqual([{ method: "getViewForMember", memberId: "member-1", storeConnectionId: 44 }]);
    });

    it.each([
      ["temporary", "DROPSHIP_EBAY_FULFILLMENT_SHIPSTATION_UNAVAILABLE", 502, true],
      ["temporary", "DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE", 503, true],
      ["setup_incomplete", "DROPSHIP_EBAY_FULFILLMENT_ROUTING_REQUIRED", 409, false],
      ["setup_incomplete", "DROPSHIP_EBAY_FULFILLMENT_NO_RATE_BOOK", 409, false],
      ["marketplace_unsupported", "DROPSHIP_EBAY_FULFILLMENT_MARKETPLACE_UNSUPPORTED", 409, false],
    ] as const)("answers an unavailable %s shipping check (%s) without the contract header as that error (%i), retryable %s", async (kind, reference, status, retryable) => {
      service.view = unavailableViewResult(reference, kind);
      server = await startServer(buildApp(service, true));

      const response = await getSetup(server.url);

      expect(response.status).toBe(status);
      expect(response.body).toEqual({
        error: {
          code: reference,
          message: "eBay listing setup is unavailable.",
          context: { storeConnectionId: 44, retryable },
        },
      });
    });

    it.each([
      ["no header", {}],
      ["contract 1", { "X-Dropship-Listing-Setup-Contract": "1" }],
      ["a contract that is not a version", { "X-Dropship-Listing-Setup-Contract": "v2" }],
    ])("treats a read with %s as a page loaded before this release", async (_label, headers) => {
      server = await startServer(buildApp(service, true));

      const response = await getSetup(server.url, headers);

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ error: { code: "DROPSHIP_LISTING_CONFIG_STORE_PAUSED" } });
    });

    it.each([
      ["without the contract header", {}],
      ["with the contract header", CONTRACT_HEADERS],
    ])("answers an editable, fully checked view as 200 %s", async (_label, headers) => {
      service.view = checkedViewResult();
      server = await startServer(buildApp(service, true));

      const response = await getSetup(server.url, headers);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(JSON.parse(JSON.stringify(checkedViewResult())));
    });

    it("still maps a service failure to its own error with the contract header", async () => {
      service.getError = new DropshipError(
        "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_TOKEN_REQUIRED",
        "Reconnect eBay to load listing setup.",
        { storeConnectionId: 44, retryable: false },
      );
      server = await startServer(buildApp(service, true));

      const response = await getSetup(server.url, CONTRACT_HEADERS);

      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        error: {
          code: "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_TOKEN_REQUIRED",
          message: "Reconnect eBay to load listing setup.",
          context: { storeConnectionId: 44, retryable: false },
        },
      });
    });
  });

  describe("PUT setup (store default save)", () => {
    it("saves a partial store default and passes the parsed body, not the raw one", async () => {
      server = await startServer(buildApp(service, true));

      const response = await putSetup(server.url, {
        expectedRevision: 7,
        idempotencyKey: `  ${REQUEST_KEY}  `,
        returnPolicyId: "  return-2  ",
      });

      expect(response.status).toBe(200);
      expect(service.calls).toEqual([{
        method: "replaceForMember",
        memberId: "member-1",
        storeConnectionId: 44,
        input: { expectedRevision: 7, idempotencyKey: REQUEST_KEY, returnPolicyId: "return-2" },
      }]);
      expect(response.body).toMatchObject({ outcome: "changed", revision: 8 });
    });

    it("passes every policy and a two-shelf default through, without requiring listing-push MFA", async () => {
      server = await startServer(buildApp(service, true));
      const body = {
        expectedRevision: 7,
        idempotencyKey: REQUEST_KEY,
        fulfillmentPolicyId: "fulfillment-1",
        returnPolicyId: "return-1",
        paymentPolicyId: "payment-1",
        storeShelfDefault: { ids: ["111", "222"] },
      };

      const response = await putSetup(server.url, body);

      expect(response.status).toBe(200);
      expect(service.calls).toEqual([{ method: "replaceForMember", memberId: "member-1", storeConnectionId: 44, input: body }]);
    });

    it("passes a null shelf default through as the removal it asks for", async () => {
      server = await startServer(buildApp(service, true));

      const response = await putSetup(server.url, {
        expectedRevision: 7,
        idempotencyKey: REQUEST_KEY,
        storeShelfDefault: null,
      });

      expect(response.status).toBe(200);
      expect(service.calls).toEqual([{
        method: "replaceForMember",
        memberId: "member-1",
        storeConnectionId: 44,
        input: { expectedRevision: 7, idempotencyKey: REQUEST_KEY, storeShelfDefault: null },
      }]);
    });

    it("still accepts the previous client's merchantLocationKey during a rolling deploy", async () => {
      server = await startServer(buildApp(service, true));
      const body = {
        expectedRevision: 7,
        idempotencyKey: REQUEST_KEY,
        merchantLocationKey: "warehouse-main",
        fulfillmentPolicyId: "fulfillment-1",
      };

      const response = await putSetup(server.url, body);

      expect(response.status).toBe(200);
      expect(service.calls).toEqual([{ method: "replaceForMember", memberId: "member-1", storeConnectionId: 44, input: body }]);
    });

    it.each([
      [
        "the previous client's whole-selection body",
        {
          merchantLocationKey: "warehouse-main",
          fulfillmentPolicyId: "fulfillment-1",
          returnPolicyId: "return-1",
          paymentPolicyId: "payment-1",
        },
      ],
      ["a body without the request key", { expectedRevision: 7, returnPolicyId: "return-1" }],
      ["a body without the revision", { idempotencyKey: REQUEST_KEY, returnPolicyId: "return-1" }],
      ["a body without the revision that also has an unknown field", { idempotencyKey: REQUEST_KEY, returnPolicyId: "return-1", listingMode: "live" }],
      ["an empty body", {}],
    ])("asks the page to reload (428) for %s and does not call the service", async (_label, body) => {
      server = await startServer(buildApp(service, true));

      const response = await putSetup(server.url, body);

      expect(response.status).toBe(428);
      expect(response.body).toEqual({
        error: {
          code: "DROPSHIP_LISTING_CONFIG_REVISION_REQUIRED",
          message: "Reload this page to load the latest store settings, then save again.",
          context: { retryable: false },
        },
      });
      expect(service.calls).toEqual([]);
    });

    it("asks the page to reload (428) for a save without the request key even when another field is also invalid", async () => {
      server = await startServer(buildApp(service, true));

      const response = await putSetup(server.url, { expectedRevision: 7, returnPolicyId: "   " });

      expect(response.status).toBe(428);
      expect(response.body).toMatchObject({ error: { code: "DROPSHIP_LISTING_CONFIG_REVISION_REQUIRED" } });
      expect(service.calls).toEqual([]);
    });

    it("rejects a request key sent as null with 400: only a missing key marks a page loaded before this release", async () => {
      server = await startServer(buildApp(service, true));

      const response = await putSetup(server.url, { expectedRevision: 7, idempotencyKey: null, returnPolicyId: "return-1" });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        error: {
          code: "DROPSHIP_EBAY_LISTING_SETUP_INVALID_INPUT",
          context: { issues: [{ path: "idempotencyKey", code: "invalid_type" }], retryable: false },
        },
      });
      expect(service.calls).toEqual([]);
    });

    it("refuses a save that changes nothing (only the revision and the request key)", async () => {
      server = await startServer(buildApp(service, true));

      const response = await putSetup(server.url, { expectedRevision: 7, idempotencyKey: REQUEST_KEY });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        error: {
          code: "DROPSHIP_EBAY_LISTING_SETUP_INVALID_INPUT",
          context: {
            issues: [{ path: "", code: "custom", message: "Send at least one policy or the shelf default to save." }],
            retryable: false,
          },
        },
      });
      expect(service.calls).toEqual([]);
    });

    it.each([
      ["an unknown top-level field", { listingMode: "live" }, "unrecognized_keys"],
      ["an unknown shelf default field", { storeShelfDefault: { ids: ["111"], names: ["Toploaders"] } }, "unrecognized_keys"],
      ["no shelves in the shelf default", { storeShelfDefault: { ids: [] } }, "too_small"],
      ["three shelves in the shelf default", { storeShelfDefault: { ids: ["111", "222", "333"] } }, "too_big"],
      ["the same shelf twice", { storeShelfDefault: { ids: ["111", "111"] } }, "custom"],
      ["a blank policy id", { returnPolicyId: "   " }, "too_small"],
      ["a zero revision", { expectedRevision: 0, returnPolicyId: "return-1" }, "too_small"],
      ["a negative revision", { expectedRevision: -1, returnPolicyId: "return-1" }, "too_small"],
      ["a fractional revision", { expectedRevision: 1.5, returnPolicyId: "return-1" }, "invalid_type"],
      ["a revision sent as text", { expectedRevision: "7", returnPolicyId: "return-1" }, "invalid_type"],
      ["a null revision", { expectedRevision: null, returnPolicyId: "return-1" }, "invalid_type"],
      ["a revision past the integer column", { expectedRevision: 2_147_483_648, returnPolicyId: "return-1" }, "too_big"],
      ["a request key that is too short", { idempotencyKey: "short", returnPolicyId: "return-1" }, "too_small"],
      ["a request key with spaces inside", { idempotencyKey: "setup save 0001", returnPolicyId: "return-1" }, "invalid_string"],
    ])("rejects %s with 400 before invoking the service", async (_label, overrides, issueCode) => {
      server = await startServer(buildApp(service, true));

      const response = await putSetup(server.url, { expectedRevision: 7, idempotencyKey: REQUEST_KEY, ...overrides });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ error: { code: "DROPSHIP_EBAY_LISTING_SETUP_INVALID_INPUT" } });
      const issues = (response.body.error as { context: { issues: Array<{ code: string }> } }).context.issues;
      expect(issues.map((issue) => issue.code)).toContain(issueCode);
      expect(service.calls).toEqual([]);
    });
  });

  describe("POST ship-from repair", () => {
    it("repairs the ship-from location with the parsed body and returns the write outcome", async () => {
      server = await startServer(buildApp(service, true));

      const response = await postRepair(server.url, { expectedRevision: 7, idempotencyKey: ` ${REQUEST_KEY} ` });

      expect(response.status).toBe(200);
      expect(service.calls).toEqual([{
        method: "repairShipFromForMember",
        memberId: "member-1",
        storeConnectionId: 44,
        input: { expectedRevision: 7, idempotencyKey: REQUEST_KEY },
      }]);
      expect(response.body).toMatchObject({ outcome: "changed", revision: 8 });
    });

    it("returns a replayed repair as the service answered it", async () => {
      service.repairOutcome = "replayed";
      server = await startServer(buildApp(service, true));

      const response = await postRepair(server.url, { expectedRevision: 7, idempotencyKey: REQUEST_KEY });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ outcome: "replayed" });
    });

    it.each([
      ["an empty body", {}],
      ["a body without the request key", { expectedRevision: 7 }],
      ["a body without the request key that also has an unknown field", { expectedRevision: 7, merchantLocationKey: "warehouse-main" }],
      ["a body without the revision", { idempotencyKey: REQUEST_KEY }],
    ])("asks the page to reload (428) for %s and does not call the service", async (_label, body) => {
      server = await startServer(buildApp(service, true));

      const response = await postRepair(server.url, body);

      expect(response.status).toBe(428);
      expect(response.body).toEqual({
        error: {
          code: "DROPSHIP_LISTING_CONFIG_REVISION_REQUIRED",
          message: "Reload this page to load the latest store settings, then save again.",
          context: { retryable: false },
        },
      });
      expect(service.calls).toEqual([]);
    });

    it.each([
      ["a location key (Card Shellz owns the location)", { merchantLocationKey: "warehouse-main" }],
      ["a policy (the repair changes nothing else)", { fulfillmentPolicyId: "fulfillment-1" }],
      ["a zero revision", { expectedRevision: 0 }],
    ])("rejects a repair with %s with 400 before invoking the service", async (_label, overrides) => {
      server = await startServer(buildApp(service, true));

      const response = await postRepair(server.url, { expectedRevision: 7, idempotencyKey: REQUEST_KEY, ...overrides });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ error: { code: "DROPSHIP_EBAY_LISTING_SETUP_INVALID_INPUT" } });
      expect(service.calls).toEqual([]);
    });

    it("maps a repair conflict like a save conflict", async () => {
      service.repairError = new DropshipError(
        "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT",
        "These settings changed since this page loaded.",
        { storeConnectionId: 44, expectedRevision: 7, currentRevision: 9, retryable: false },
      );
      server = await startServer(buildApp(service, true));

      const response = await postRepair(server.url, { expectedRevision: 7, idempotencyKey: REQUEST_KEY });

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        error: {
          code: "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT",
          context: { storeConnectionId: 44, expectedRevision: 7, currentRevision: 9, retryable: false },
        },
      });
    });
  });

  describe("error mapping for setup writes", () => {
    it.each([
      ["DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT", 409],
      ["DROPSHIP_LISTING_CONFIG_IDEMPOTENCY_CONFLICT", 409],
      ["DROPSHIP_LISTING_CONFIG_STORE_PAUSED", 409],
      ["DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTING", 409],
      ["DROPSHIP_LISTING_CONFIG_STORE_NOT_WRITABLE", 409],
      ["DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTED", 409],
      ["DROPSHIP_STORE_CONNECTION_NOT_CONNECTED", 409],
      ["DROPSHIP_EBAY_STORE_SHELF_DEFAULT_INVALID", 400],
      ["DROPSHIP_EBAY_LISTING_SETUP_SELECTION_INVALID", 400],
      ["DROPSHIP_EBAY_STORE_CATEGORIES_PERMISSION_REQUIRED", 403],
      ["DROPSHIP_EBAY_STORE_CATEGORIES_ACCESS_DENIED", 403],
      ["DROPSHIP_LISTING_CONFIG_VENDOR_BLOCKED", 403],
      ["DROPSHIP_EBAY_STORE_CATEGORIES_UNAVAILABLE", 502],
      ["DROPSHIP_EBAY_STORE_CATEGORIES_INVALID_RESPONSE", 502],
      ["DROPSHIP_LISTING_CONFIG_REVISION_REQUIRED", 428],
      ["DROPSHIP_EBAY_FULFILLMENT_POLICY_INCOMPATIBLE", 422],
      ["DROPSHIP_STORE_CONNECTION_NOT_FOUND", 404],
      ["DROPSHIP_SOMETHING_UNMAPPED", 500],
    ])("maps %s to %i", async (code, status) => {
      service.replaceError = new DropshipError(code, "Controlled failure.", { storeConnectionId: 44, retryable: false });
      server = await startServer(buildApp(service, true));

      const response = await putSetup(server.url, { expectedRevision: 7, idempotencyKey: REQUEST_KEY, returnPolicyId: "return-1" });

      expect(response.status).toBe(status);
      expect(response.body).toMatchObject({ error: { code, message: "Controlled failure." } });
    });

    it("passes the revisions a conflicted page needs and drops every other context key", async () => {
      service.replaceError = new DropshipError(
        "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT",
        "These settings changed since this page loaded.",
        {
          storeConnectionId: 44,
          expectedRevision: 7,
          currentRevision: 9,
          retryable: false,
          vendorId: 10,
          requestHash: "a".repeat(64),
          idempotencyKey: REQUEST_KEY,
          sql: "UPDATE dropship.dropship_store_listing_configs ...",
        },
      );
      server = await startServer(buildApp(service, true));

      const response = await putSetup(server.url, { expectedRevision: 7, idempotencyKey: REQUEST_KEY, returnPolicyId: "return-1" });

      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        error: {
          code: "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT",
          message: "These settings changed since this page loaded.",
          context: { storeConnectionId: 44, expectedRevision: 7, currentRevision: 9, retryable: false },
        },
      });
    });

    it("keeps the store status but not the vendor id on a read-only store refusal", async () => {
      service.replaceError = new DropshipError(
        "DROPSHIP_LISTING_CONFIG_STORE_PAUSED",
        "This store is paused.",
        { vendorId: 10, storeConnectionId: 44, status: "paused", retryable: false },
      );
      server = await startServer(buildApp(service, true));

      const response = await putSetup(server.url, { expectedRevision: 7, idempotencyKey: REQUEST_KEY, returnPolicyId: "return-1" });

      expect(response.status).toBe(409);
      expect((response.body.error as { context: unknown }).context).toEqual({
        storeConnectionId: 44,
        status: "paused",
        retryable: false,
      });
    });

    it("omits the context when none of its keys are public", async () => {
      service.replaceError = new DropshipError(
        "DROPSHIP_LISTING_CONFIG_IDEMPOTENCY_CONFLICT",
        "This request key was already used for a different save.",
        { vendorId: 10, requestHash: "b".repeat(64), priorOperation: "ebay_listing_setup_save" },
      );
      server = await startServer(buildApp(service, true));

      const response = await putSetup(server.url, { expectedRevision: 7, idempotencyKey: REQUEST_KEY, returnPolicyId: "return-1" });

      expect(response.status).toBe(409);
      expect(response.body.error).toEqual({
        code: "DROPSHIP_LISTING_CONFIG_IDEMPOTENCY_CONFLICT",
        message: "This request key was already used for a different save.",
      });
    });

    it("hides an unexpected failure behind a generic 500", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      service.replaceError = new Error("connection string postgres://secret");
      server = await startServer(buildApp(service, true));

      const response = await putSetup(server.url, { expectedRevision: 7, idempotencyKey: REQUEST_KEY, returnPolicyId: "return-1" });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: {
          code: "DROPSHIP_EBAY_LISTING_SETUP_INTERNAL_ERROR",
          message: "eBay listing setup request failed.",
        },
      });
      expect(consoleError).toHaveBeenCalledTimes(1);
    });
  });

  describe("write rate limit", () => {
    it("allows 60 setup writes a minute per member", () => {
      expect(LISTING_SETUP_WRITES_PER_MINUTE).toBe(60);
    });

    it("refuses the next save or repair once a member spends the write budget, and not another member's", async () => {
      server = await startServer(buildApp(service, true));
      const saveBody = { expectedRevision: 7, idempotencyKey: REQUEST_KEY, returnPolicyId: "return-1" };
      const repairBody = { expectedRevision: 7, idempotencyKey: REQUEST_KEY };
      const saves = Math.ceil(LISTING_SETUP_WRITES_PER_MINUTE / 2);

      for (let index = 0; index < saves; index += 1) {
        expect((await putSetup(server.url, saveBody)).status).toBe(200);
      }
      for (let index = saves; index < LISTING_SETUP_WRITES_PER_MINUTE; index += 1) {
        expect((await postRepair(server.url, repairBody)).status).toBe(200);
      }

      const limitedSave = await putSetup(server.url, saveBody);
      expect(limitedSave.status).toBe(429);
      expect(limitedSave.body).toEqual({
        error: {
          code: "DROPSHIP_EBAY_LISTING_SETUP_RATE_LIMITED",
          message: "Too many saves in a minute. Wait a moment and try again.",
        },
      });
      // Save and repair spend one budget.
      const limitedRepair = await postRepair(server.url, repairBody);
      expect(limitedRepair.status).toBe(429);
      expect(limitedRepair.body).toMatchObject({ error: { code: "DROPSHIP_EBAY_LISTING_SETUP_RATE_LIMITED" } });
      expect(service.calls).toHaveLength(LISTING_SETUP_WRITES_PER_MINUTE);

      expect((await putSetup(server.url, saveBody, "member-2")).status).toBe(200);
      expect(service.calls.at(-1)).toMatchObject({ method: "replaceForMember", memberId: "member-2" });
    });

    it("advertises the write budget on a save", async () => {
      server = await startServer(buildApp(service, true));

      const response = await putSetup(server.url, { expectedRevision: 7, idempotencyKey: REQUEST_KEY, returnPolicyId: "return-1" });

      expect(response.status).toBe(200);
      expect(response.headers.get("ratelimit-limit")).toBe(String(LISTING_SETUP_WRITES_PER_MINUTE));
    });

    it("does not limit reads, and reads do not spend the write budget", async () => {
      server = await startServer(buildApp(service, true));

      for (let index = 0; index < LISTING_SETUP_WRITES_PER_MINUTE + 5; index += 1) {
        const read = await getSetup(server.url, CONTRACT_HEADERS);
        expect(read.status).toBe(200);
        expect(read.headers.get("ratelimit-limit")).toBeNull();
      }

      const save = await putSetup(server.url, { expectedRevision: 7, idempotencyKey: REQUEST_KEY, returnPolicyId: "return-1" });
      expect(save.status).toBe(200);
      expect(save.headers.get("ratelimit-remaining")).toBe(String(LISTING_SETUP_WRITES_PER_MINUTE - 1));
    });

    it("does not spend the write budget on a read refused to a page loaded before this release", async () => {
      server = await startServer(buildApp(service, true));

      for (let index = 0; index < 5; index += 1) {
        const read = await getSetup(server.url);
        expect(read.status).toBe(409);
        expect(read.headers.get("ratelimit-limit")).toBeNull();
      }

      const save = await putSetup(server.url, { expectedRevision: 7, idempotencyKey: REQUEST_KEY, returnPolicyId: "return-1" });
      expect(save.headers.get("ratelimit-remaining")).toBe(String(LISTING_SETUP_WRITES_PER_MINUTE - 1));
    });

    it("keeps serving reads after the member spends the write budget", async () => {
      server = await startServer(buildApp(service, true));
      const saveBody = { expectedRevision: 7, idempotencyKey: REQUEST_KEY, returnPolicyId: "return-1" };
      for (let index = 0; index < LISTING_SETUP_WRITES_PER_MINUTE; index += 1) {
        expect((await putSetup(server.url, saveBody)).status).toBe(200);
      }
      expect((await putSetup(server.url, saveBody)).status).toBe(429);

      const read = await getSetup(server.url, CONTRACT_HEADERS);

      expect(read.status).toBe(200);
      expect(read.body).toEqual(JSON.parse(JSON.stringify(viewResult())));
      expect(service.calls.at(-1)).toEqual({ method: "getViewForMember", memberId: "member-1", storeConnectionId: 44 });
    });
  });

  describe("authentication", () => {
    it.each([
      ["GET", SETUP_PATH, undefined],
      ["PUT", SETUP_PATH, { expectedRevision: 7, idempotencyKey: REQUEST_KEY, returnPolicyId: "return-1" }],
      ["POST", REPAIR_PATH, { expectedRevision: 7, idempotencyKey: REQUEST_KEY }],
    ])("requires a dropship session for %s %s", async (method, path, body) => {
      server = await startServer(buildApp(service, false));

      const response = await jsonRequest(`${server.url}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({ error: { code: "DROPSHIP_AUTH_REQUIRED" } });
      expect(service.calls).toEqual([]);
    });
  });
});

type FakeCall =
  | { method: "getViewForMember"; memberId: string; storeConnectionId: number }
  | { method: "replaceForMember" | "repairShipFromForMember"; memberId: string; storeConnectionId: number; input: unknown };

class FakeService {
  calls: FakeCall[] = [];
  getError: Error | null = null;
  replaceError: Error | null = null;
  repairError: Error | null = null;
  repairOutcome: DropshipEbayListingSetupWriteResult["outcome"] = "changed";
  /** What the setup read answers; the paused, read-only view unless a test says otherwise. */
  view: DropshipEbayListingSetupResult = viewResult();

  async getViewForMember(memberId: string, storeConnectionId: number): Promise<DropshipEbayListingSetupResult> {
    this.calls.push({ method: "getViewForMember", memberId, storeConnectionId });
    if (this.getError) throw this.getError;
    return this.view;
  }

  async replaceForMember(
    memberId: string,
    storeConnectionId: number,
    input: unknown,
  ): Promise<DropshipEbayListingSetupWriteResult> {
    this.calls.push({ method: "replaceForMember", memberId, storeConnectionId, input });
    if (this.replaceError) throw this.replaceError;
    return writeResult("changed");
  }

  async repairShipFromForMember(
    memberId: string,
    storeConnectionId: number,
    input: unknown,
  ): Promise<DropshipEbayListingSetupWriteResult> {
    this.calls.push({ method: "repairShipFromForMember", memberId, storeConnectionId, input });
    if (this.repairError) throw this.repairError;
    return writeResult(this.repairOutcome);
  }
}

/** What the route GET serves for a paused store: read-only, no eBay call, nothing judged. */
function viewResult(): DropshipEbayListingSetupResult {
  return {
    storeConnectionId: 44,
    marketplaceId: "EBAY_US",
    complete: false,
    missingFields: [],
    fulfillmentCapability: null,
    selection: {
      merchantLocationKey: "warehouse-main",
      fulfillmentPolicyId: "fulfillment-1",
      returnPolicyId: "return-1",
      paymentPolicyId: "payment-1",
    },
    options: {
      merchantLocations: [],
      fulfillmentPolicies: [],
      returnPolicies: [],
      paymentPolicies: [],
    },
    revision: 7,
    access: { canEdit: false, reason: "store_paused" },
    checks: { ebay: "not_checked", fulfillment: { status: "not_checked" } },
    storedNames: {
      fulfillmentPolicyName: "Standard",
      returnPolicyName: "Thirty days",
      paymentPolicyName: "Managed payments",
    },
    storeShelfDefault: { ids: ["111"], names: ["Toploaders"] },
  };
}

/** What the route GET serves for an editable store when eBay and Card Shellz shipping were both read. */
function checkedViewResult(): DropshipEbayListingSetupResult {
  return {
    ...viewResult(),
    complete: true,
    fulfillmentCapability: {
      marketplaceId: "EBAY_US",
      requiredHandlingTimeBusinessDays: 1,
      destinationCountry: "US",
      destinationRegions: ["US-48"],
      destinationCoverageComplete: true,
      supportedServices: [{
        carrier: "USPS",
        ebayServiceCode: "USPSGround",
        serviceName: "USPS Ground Advantage",
        shipStationCarrierCode: "stamps_com",
        shipStationServiceCode: "usps_ground_advantage",
      }],
      evidenceHash: "c".repeat(64),
      source: {
        omsChannelId: 3,
        originWarehouseId: 1,
        rateBookId: 5,
        rateBookCode: "standard",
        rateTableId: 9,
        serviceLevelId: 7,
        fulfillmentRoutingRevision: 2,
      },
    },
    access: { canEdit: true, reason: null },
    checks: { ebay: "checked", fulfillment: { status: "checked" } },
    options: {
      merchantLocations: [{ id: "warehouse-main", name: "Main warehouse" }],
      fulfillmentPolicies: [{
        id: "fulfillment-1",
        name: "Standard",
        compatible: true,
        compatibilityChecked: true,
        compatibilityIssues: [],
      }],
      returnPolicies: [{ id: "return-1", name: "Thirty days" }],
      paymentPolicies: [{ id: "payment-1", name: "Managed payments" }],
    },
  };
}

/**
 * What the route GET serves for an editable store when Card Shellz shipping
 * could not be read: eBay's lists, every shipping policy unchecked, and the
 * failure's code as the support reference.
 */
function unavailableViewResult(
  reference: string,
  kind: DropshipEbayFulfillmentUnavailableKind,
): DropshipEbayListingSetupResult {
  const checked = checkedViewResult();
  return {
    ...checked,
    complete: false,
    fulfillmentCapability: null,
    checks: { ebay: "checked", fulfillment: { status: "unavailable", reference, kind } },
    options: {
      ...checked.options,
      fulfillmentPolicies: [{
        id: "fulfillment-1",
        name: "Standard",
        compatible: false,
        compatibilityChecked: false,
        compatibilityIssues: [],
      }],
    },
  };
}

function writeResult(outcome: DropshipEbayListingSetupWriteResult["outcome"]): DropshipEbayListingSetupWriteResult {
  return { ...checkedViewResult(), revision: 8, outcome };
}

function buildApp(service: FakeService, authenticated: boolean): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const memberId = req.header(MEMBER_HEADER) ?? "member-1";
    (req as unknown as { session: Record<string, unknown> }).session = authenticated
      ? {
          dropship: {
            authIdentityId: 1,
            memberId,
            cardShellzEmail: "vendor@cardshellz.test",
            hasPasskey: false,
            authMethod: "password",
            entitlementStatus: "active",
            authenticatedAt: "2026-08-30T12:00:00.000Z",
          },
          dropshipSensitiveProofs: {},
        }
      : {};
    next();
  });
  registerDropshipEbayListingSetupRoutes(
    app,
    service as unknown as DropshipEbayListingSetupService,
  );
  return app;
}

async function startServer(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const listener = http.createServer(app);
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      listener.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function getSetup(baseUrl: string, headers: Readonly<Record<string, string>> = {}) {
  return jsonRequest(`${baseUrl}${SETUP_PATH}`, { headers: { ...headers } });
}

function putSetup(baseUrl: string, body: unknown, memberId?: string) {
  return writeRequest("PUT", `${baseUrl}${SETUP_PATH}`, body, memberId);
}

function postRepair(baseUrl: string, body: unknown, memberId?: string) {
  return writeRequest("POST", `${baseUrl}${REPAIR_PATH}`, body, memberId);
}

function writeRequest(method: "PUT" | "POST", url: string, body: unknown, memberId?: string) {
  return jsonRequest(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(memberId ? { [MEMBER_HEADER]: memberId } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function jsonRequest(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; headers: Headers; body: Record<string, unknown> }> {
  const response = await fetch(url, init);
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json() as Record<string, unknown>,
  };
}
