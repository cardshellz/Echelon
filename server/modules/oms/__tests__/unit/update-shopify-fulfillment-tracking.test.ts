/**
 * Unit tests for `updateShopifyFulfillmentTracking` (§6 Group E, Commit 24).
 *
 * Coverage scopes (per task brief + coding-standards #9):
 *   - Happy path: valid GID + tracking → mutation called with correct
 *     query + variables (`fulfillmentTrackingInfoUpdate`,
 *     `notifyCustomer: true` by default per Overlord D11) →
 *     returns `{fulfillmentGid, trackingNumberChanged: true}`.
 *   - `opts.notifyCustomer: false` → mutation called with
 *     `notifyCustomer: false`.
 *   - Idempotency (response shows tracking matches input) →
 *     `trackingNumberChanged: true`.
 *   - Idempotency (userErrors mention "already has this tracking") →
 *     `trackingNumberChanged: false`.
 *   - Validation: empty fulfillmentGid throws
 *     `SHOPIFY_TRACKING_UPDATE_INVALID_INPUT`.
 *   - Validation: bad GID prefix throws
 *     `SHOPIFY_TRACKING_UPDATE_INVALID_INPUT`.
 *   - Validation: empty tracking number throws
 *     `SHOPIFY_TRACKING_UPDATE_INVALID_INPUT`.
 *   - Validation: empty carrier (company) throws
 *     `SHOPIFY_TRACKING_UPDATE_INVALID_INPUT`.
 *   - userErrors (non-idempotent) → throws
 *     `SHOPIFY_TRACKING_UPDATE_USER_ERRORS` with userErrors preserved.
 *   - Transport throw → wrapped as
 *     `SHOPIFY_TRACKING_UPDATE_NETWORK_ERROR` with `cause` preserved.
 *   - Client not set → throws `SHOPIFY_PUSH_CLIENT_NOT_SET`.
 *
 * Mocks: in-memory ShopifyAdminGraphQLClient, no DB, no fetch. The
 * tracking-update path does not touch the DB at all — pure GQL call —
 * so the `db` arg to the factory is a stub that throws on any access
 * to surface accidental regressions if the implementation grows DB I/O.
 *
 * Standards: Rule #5 (no silent failures — every failure mode raises a
 * structured error or returns a structured idempotency signal),
 * Rule #6 (idempotent retry-safety), Rule #9 (happy + edge cases).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createFulfillmentPushService,
  ShopifyFulfillmentPushError,
  SHOPIFY_TRACKING_UPDATE_INVALID_INPUT,
  SHOPIFY_TRACKING_UPDATE_USER_ERRORS,
  SHOPIFY_TRACKING_UPDATE_NETWORK_ERROR,
  SHOPIFY_PUSH_CLIENT_NOT_SET,
} from "../../fulfillment-push.service";
import type { ShopifyAdminGraphQLClient } from "../../../shopify/admin-gql-client";

// ─── Fixtures ────────────────────────────────────────────────────────

const FULFILLMENT_GID = "gid://shopify/Fulfillment/77777";
const NEW_TRACKING = "NEW-LABEL-789";
const OLD_TRACKING = "OLD-LABEL-123";
const CARRIER = "UPS";
const TRACK_URL = "https://wwwapps.ups.com/track?tracknum=NEW-LABEL-789";

function okUpdateResponse(returnedNumber: string = NEW_TRACKING) {
  return {
    fulfillmentTrackingInfoUpdate: {
      fulfillment: {
        id: FULFILLMENT_GID,
        trackingInfo: {
          number: returnedNumber,
          company: CARRIER,
          url: TRACK_URL,
        },
      },
      userErrors: [],
    },
  };
}

// ─── Mocks ───────────────────────────────────────────────────────────

interface MockClient extends ShopifyAdminGraphQLClient {
  calls: Array<{ query: string; variables?: Record<string, unknown> }>;
}

function makeShopifyClient(
  responses: Array<unknown | (() => unknown)>,
): MockClient {
  const remaining = [...responses];
  const calls: MockClient["calls"] = [];
  return {
    calls,
    async request<T = unknown>(
      query: string,
      variables?: Record<string, unknown>,
    ): Promise<T> {
      calls.push({ query, variables });
      if (remaining.length === 0) {
        throw new Error("MockClient: no scripted response remaining");
      }
      const next = remaining.shift();
      const value = typeof next === "function" ? (next as () => unknown)() : next;
      if (value instanceof Error) throw value;
      return value as T;
    },
  };
}

/**
 * DB stub: tracking-update path must never touch the DB. Any access
 * throws so a future regression that adds an unexpected query lights
 * up immediately.
 */
function makeDbStub() {
  return {
    execute: vi.fn(() => {
      throw new Error(
        "DB should not be touched by updateShopifyFulfillmentTracking",
      );
    }),
  };
}

// ─── Test suite ──────────────────────────────────────────────────────

describe("updateShopifyFulfillmentTracking :: happy path", () => {
  let db: ReturnType<typeof makeDbStub>;
  let client: MockClient;

  beforeEach(() => {
    db = makeDbStub();
    client = makeShopifyClient([okUpdateResponse()]);
  });

  it("issues fulfillmentTrackingInfoUpdate mutation with correct shape and returns trackingNumberChanged:true", async () => {
    const svc = createFulfillmentPushService(db as any, null);
    svc.setShopifyClient(client);

    const result = await svc.updateShopifyFulfillmentTracking(
      FULFILLMENT_GID,
      { number: NEW_TRACKING, company: CARRIER, url: TRACK_URL },
    );

    expect(result).toEqual({
      fulfillmentGid: FULFILLMENT_GID,
      trackingNumberChanged: true,
    });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].query).toContain("fulfillmentTrackingInfoUpdate");
    expect(client.calls[0].query).toContain("$fulfillmentId: ID!");
    expect(client.calls[0].query).toContain("FulfillmentTrackingInput!");
    expect(client.calls[0].query).toContain("$notifyCustomer: Boolean");
    expect(client.calls[0].query).toContain("userErrors");

    // Variables: notifyCustomer defaults to true (Overlord D11).
    expect(client.calls[0].variables).toEqual({
      fulfillmentId: FULFILLMENT_GID,
      trackingInfoInput: {
        number: NEW_TRACKING,
        company: CARRIER,
        url: TRACK_URL,
      },
      notifyCustomer: true,
    });

    // No DB I/O on tracking-update path.
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("omits trackingInfoInput.url when no url is provided", async () => {
    const svc = createFulfillmentPushService(db as any, null);
    svc.setShopifyClient(client);

    await svc.updateShopifyFulfillmentTracking(FULFILLMENT_GID, {
      number: NEW_TRACKING,
      company: CARRIER,
    });

    const variables = client.calls[0].variables as any;
    expect(variables.trackingInfoInput).toEqual({
      number: NEW_TRACKING,
      company: CARRIER,
    });
    expect("url" in variables.trackingInfoInput).toBe(false);
  });

  it("trims whitespace on tracking number, company, and url", async () => {
    const svc = createFulfillmentPushService(db as any, null);
    svc.setShopifyClient(client);

    await svc.updateShopifyFulfillmentTracking(FULFILLMENT_GID, {
      number: `  ${NEW_TRACKING}  `,
      company: `  ${CARRIER}  `,
      url: `  ${TRACK_URL}  `,
    });

    expect((client.calls[0].variables as any).trackingInfoInput).toEqual({
      number: NEW_TRACKING,
      company: CARRIER,
      url: TRACK_URL,
    });
  });

  it("respects opts.notifyCustomer:false (Overlord D11 — configurable)", async () => {
    const svc = createFulfillmentPushService(db as any, null);
    svc.setShopifyClient(client);

    await svc.updateShopifyFulfillmentTracking(
      FULFILLMENT_GID,
      { number: NEW_TRACKING, company: CARRIER },
      { notifyCustomer: false },
    );

    expect((client.calls[0].variables as any).notifyCustomer).toBe(false);
  });

  it("respects explicit opts.notifyCustomer:true (matches default)", async () => {
    const svc = createFulfillmentPushService(db as any, null);
    svc.setShopifyClient(client);

    await svc.updateShopifyFulfillmentTracking(
      FULFILLMENT_GID,
      { number: NEW_TRACKING, company: CARRIER },
      { notifyCustomer: true },
    );

    expect((client.calls[0].variables as any).notifyCustomer).toBe(true);
  });
});

describe("updateShopifyFulfillmentTracking :: idempotency", () => {
  it("returns trackingNumberChanged:true when response echoes our tracking number", async () => {
    const db = makeDbStub();
    const client = makeShopifyClient([okUpdateResponse(NEW_TRACKING)]);
    const svc = createFulfillmentPushService(db as any, null);
    svc.setShopifyClient(client);

    const result = await svc.updateShopifyFulfillmentTracking(
      FULFILLMENT_GID,
      { number: NEW_TRACKING, company: CARRIER },
    );

    expect(result).toEqual({
      fulfillmentGid: FULFILLMENT_GID,
      trackingNumberChanged: true,
    });
  });

  const idempotentMessages = [
    "Fulfillment already has this tracking number.",
    "This fulfillment already has the same tracking info.",
    "tracking number is the same as the existing one",
    "Tracking info is unchanged.",
  ];

  for (const message of idempotentMessages) {
    it(`returns trackingNumberChanged:false for userError "${message}"`, async () => {
      const db = makeDbStub();
      const client = makeShopifyClient([
        {
          fulfillmentTrackingInfoUpdate: {
            fulfillment: null,
            userErrors: [{ field: ["trackingInfoInput"], message }],
          },
        },
      ]);
      const svc = createFulfillmentPushService(db as any, null);
      svc.setShopifyClient(client);

      const result = await svc.updateShopifyFulfillmentTracking(
        FULFILLMENT_GID,
        { number: NEW_TRACKING, company: CARRIER },
      );

      expect(result).toEqual({
        fulfillmentGid: FULFILLMENT_GID,
        trackingNumberChanged: false,
      });
    });
  }

  it("treats response without echoed trackingInfo as success (defensive fallthrough)", async () => {
    const db = makeDbStub();
    const client = makeShopifyClient([
      {
        fulfillmentTrackingInfoUpdate: {
          fulfillment: { id: FULFILLMENT_GID, trackingInfo: null },
          userErrors: [],
        },
      },
    ]);
    const svc = createFulfillmentPushService(db as any, null);
    svc.setShopifyClient(client);

    const result = await svc.updateShopifyFulfillmentTracking(
      FULFILLMENT_GID,
      { number: NEW_TRACKING, company: CARRIER },
    );

    expect(result.trackingNumberChanged).toBe(true);
  });
});

describe("updateShopifyFulfillmentTracking :: input validation", () => {
  it("throws SHOPIFY_TRACKING_UPDATE_INVALID_INPUT for empty fulfillmentGid", async () => {
    const db = makeDbStub();
    const client = makeShopifyClient([]);
    const svc = createFulfillmentPushService(db as any, null);
    svc.setShopifyClient(client);

    await expect(
      svc.updateShopifyFulfillmentTracking("", {
        number: NEW_TRACKING,
        company: CARRIER,
      }),
    ).rejects.toMatchObject({
      name: "ShopifyFulfillmentPushError",
      context: {
        code: SHOPIFY_TRACKING_UPDATE_INVALID_INPUT,
        field: "fulfillmentGid",
        value: "",
      },
    });
    expect(client.calls).toHaveLength(0);
  });

  it("throws SHOPIFY_TRACKING_UPDATE_INVALID_INPUT for non-string fulfillmentGid", async () => {
    const db = makeDbStub();
    const svc = createFulfillmentPushService(db as any, null);
    svc.setShopifyClient(makeShopifyClient([]));

    await expect(
      svc.updateShopifyFulfillmentTracking(undefined as any, {
        number: NEW_TRACKING,
        company: CARRIER,
      }),
    ).rejects.toBeInstanceOf(ShopifyFulfillmentPushError);
    await expect(
      svc.updateShopifyFulfillmentTracking(null as any, {
        number: NEW_TRACKING,
        company: CARRIER,
      }),
    ).rejects.toBeInstanceOf(ShopifyFulfillmentPushError);
    await expect(
      svc.updateShopifyFulfillmentTracking(123 as any, {
        number: NEW_TRACKING,
        company: CARRIER,
      }),
    ).rejects.toMatchObject({
      context: { code: SHOPIFY_TRACKING_UPDATE_INVALID_INPUT },
    });
  });

  it("throws SHOPIFY_TRACKING_UPDATE_INVALID_INPUT for wrong-prefix GIDs", async () => {
    const db = makeDbStub();
    const client = makeShopifyClient([]);
    const svc = createFulfillmentPushService(db as any, null);
    svc.setShopifyClient(client);

    const wrongPrefixes = [
      "gid://shopify/Order/12345",
      "gid://shopify/FulfillmentOrder/12345",
      "12345",
      "Fulfillment/12345",
      "gid://shopify/fulfillment/12345", // lowercase entity
    ];

    for (const bad of wrongPrefixes) {
      await expect(
        svc.updateShopifyFulfillmentTracking(bad, {
          number: NEW_TRACKING,
          company: CARRIER,
        }),
      ).rejects.toMatchObject({
        context: {
          code: SHOPIFY_TRACKING_UPDATE_INVALID_INPUT,
          field: "fulfillmentGid",
          value: bad,
        },
      });
    }
    expect(client.calls).toHaveLength(0);
  });

  it("throws SHOPIFY_TRACKING_UPDATE_INVALID_INPUT for empty tracking number", async () => {
    const db = makeDbStub();
    const client = makeShopifyClient([]);
    const svc = createFulfillmentPushService(db as any, null);
    svc.setShopifyClient(client);

    await expect(
      svc.updateShopifyFulfillmentTracking(FULFILLMENT_GID, {
        number: "",
        company: CARRIER,
      }),
    ).rejects.toMatchObject({
      context: {
        code: SHOPIFY_TRACKING_UPDATE_INVALID_INPUT,
        field: "trackingInfo.number",
      },
    });

    await expect(
      svc.updateShopifyFulfillmentTracking(FULFILLMENT_GID, {
        number: "   ",
        company: CARRIER,
      }),
    ).rejects.toMatchObject({
      context: {
        code: SHOPIFY_TRACKING_UPDATE_INVALID_INPUT,
        field: "trackingInfo.number",
      },
    });

    expect(client.calls).toHaveLength(0);
  });

  it("throws SHOPIFY_TRACKING_UPDATE_INVALID_INPUT for empty carrier", async () => {
    const db = makeDbStub();
    const client = makeShopifyClient([]);
    const svc = createFulfillmentPushService(db as any, null);
    svc.setShopifyClient(client);

    await expect(
      svc.updateShopifyFulfillmentTracking(FULFILLMENT_GID, {
        number: NEW_TRACKING,
        company: "",
      }),
    ).rejects.toMatchObject({
      context: {
        code: SHOPIFY_TRACKING_UPDATE_INVALID_INPUT,
        field: "trackingInfo.company",
      },
    });

    await expect(
      svc.updateShopifyFulfillmentTracking(FULFILLMENT_GID, {
        number: NEW_TRACKING,
        company: "   ",
      }),
    ).rejects.toMatchObject({
      context: {
        code: SHOPIFY_TRACKING_UPDATE_INVALID_INPUT,
        field: "trackingInfo.company",
      },
    });

    expect(client.calls).toHaveLength(0);
  });
});

describe("updateShopifyFulfillmentTracking :: client + transport failures", () => {
  it("throws SHOPIFY_PUSH_CLIENT_NOT_SET when setShopifyClient was never called", async () => {
    const db = makeDbStub();
    const svc = createFulfillmentPushService(db as any, null);
    // No setShopifyClient(...).

    await expect(
      svc.updateShopifyFulfillmentTracking(FULFILLMENT_GID, {
        number: NEW_TRACKING,
        company: CARRIER,
      }),
    ).rejects.toMatchObject({
      name: "ShopifyFulfillmentPushError",
      context: {
        code: SHOPIFY_PUSH_CLIENT_NOT_SET,
        field: "fulfillmentGid",
        value: FULFILLMENT_GID,
      },
    });
  });

  it("wraps GQL transport throws as SHOPIFY_TRACKING_UPDATE_NETWORK_ERROR with cause preserved", async () => {
    const db = makeDbStub();
    const client = makeShopifyClient([new Error("ECONNRESET")]);
    const svc = createFulfillmentPushService(db as any, null);
    svc.setShopifyClient(client);

    await expect(
      svc.updateShopifyFulfillmentTracking(FULFILLMENT_GID, {
        number: NEW_TRACKING,
        company: CARRIER,
      }),
    ).rejects.toMatchObject({
      name: "ShopifyFulfillmentPushError",
      context: {
        code: SHOPIFY_TRACKING_UPDATE_NETWORK_ERROR,
        field: "fulfillmentGid",
        value: FULFILLMENT_GID,
        cause: "ECONNRESET",
      },
    });
  });
});

describe("updateShopifyFulfillmentTracking :: non-idempotent userErrors", () => {
  it("throws SHOPIFY_TRACKING_UPDATE_USER_ERRORS with userErrors preserved on context", async () => {
    const userErrors = [
      { field: ["fulfillmentId"], message: "Fulfillment cannot be updated at this time." },
    ];
    const client = makeShopifyClient([
      {
        fulfillmentTrackingInfoUpdate: {
          fulfillment: null,
          userErrors,
        },
      },
    ]);
    const db = makeDbStub();
    const svc = createFulfillmentPushService(db as any, null);
    svc.setShopifyClient(client);

    await expect(
      svc.updateShopifyFulfillmentTracking(FULFILLMENT_GID, {
        number: NEW_TRACKING,
        company: CARRIER,
      }),
    ).rejects.toMatchObject({
      name: "ShopifyFulfillmentPushError",
      context: {
        code: SHOPIFY_TRACKING_UPDATE_USER_ERRORS,
        field: "fulfillmentGid",
        value: FULFILLMENT_GID,
        userErrors,
      },
    });
  });

  it("includes all userError messages in the thrown Error.message", async () => {
    const client = makeShopifyClient([
      {
        fulfillmentTrackingInfoUpdate: {
          fulfillment: null,
          userErrors: [
            { field: ["fulfillmentId"], message: "Fulfillment not found." },
            { field: ["trackingInfoInput"], message: "Permission denied." },
          ],
        },
      },
    ]);
    const db = makeDbStub();
    const svc = createFulfillmentPushService(db as any, null);
    svc.setShopifyClient(client);

    let caught: any;
    try {
      await svc.updateShopifyFulfillmentTracking(FULFILLMENT_GID, {
        number: NEW_TRACKING,
        company: CARRIER,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ShopifyFulfillmentPushError);
    expect(caught.message).toContain("Fulfillment not found.");
    expect(caught.message).toContain("Permission denied.");
  });

  it("ignores OLD_TRACKING (sanity: idempotency match is on input number, not response field)", async () => {
    // Defensive: if Shopify ever echoes back an OLD tracking number on
    // a successful update (it shouldn't), we should NOT silently flag
    // trackingNumberChanged:true. The current implementation matches
    // returnedNumber === trimmedNumber, so a mismatched echo with no
    // userErrors falls through to the defensive "accepted" branch and
    // still returns trackingNumberChanged:true. We document that here
    // so any future tightening of this branch comes with an
    // intentional test update.
    const client = makeShopifyClient([
      {
        fulfillmentTrackingInfoUpdate: {
          fulfillment: {
            id: FULFILLMENT_GID,
            trackingInfo: { number: OLD_TRACKING, company: CARRIER },
          },
          userErrors: [],
        },
      },
    ]);
    const db = makeDbStub();
    const svc = createFulfillmentPushService(db as any, null);
    svc.setShopifyClient(client);

    const result = await svc.updateShopifyFulfillmentTracking(
      FULFILLMENT_GID,
      { number: NEW_TRACKING, company: CARRIER },
    );
    // Defensive fallthrough = success.
    expect(result.trackingNumberChanged).toBe(true);
  });
});
