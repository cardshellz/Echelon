/**
 * Unit tests for `cancelShopifyFulfillment` (§6 Group E, Commit 23).
 *
 * Coverage scopes:
 *   - Happy path: valid fulfillment GID → mutation called once with the
 *     correct query + variables → returns `{fulfillmentGid, alreadyCancelled:false}`.
 *   - Idempotency (Overlord D10 + plan §6 C23):
 *       userErrors mentioning "already cancelled" / "cancelled state"
 *       (case-insensitive, both spellings) → returns
 *       `{fulfillmentGid, alreadyCancelled:true}` without throwing.
 *   - Validation: non-string, empty string, wrong-prefix GIDs throw
 *     `SHOPIFY_CANCEL_INVALID_INPUT` with structured context.
 *   - Non-idempotent userErrors → throws `SHOPIFY_CANCEL_USER_ERRORS`
 *     with the userErrors array preserved on context.
 *   - Network/transport throw → wrapped in `SHOPIFY_CANCEL_NETWORK_ERROR`
 *     with the underlying cause on context.
 *   - Client-not-set → throws `SHOPIFY_PUSH_CLIENT_NOT_SET` (reused
 *     constant from C21 — the cancel path uses the same DI handle).
 *   - notifyCustomer opt is accepted (D10) and does NOT alter the
 *     mutation payload — Shopify's current `fulfillmentCancel(id: ID!)`
 *     does not take a notifyCustomer arg, but the option is preserved
 *     on the public signature for forward-compat.
 *
 * Mocks: in-memory ShopifyAdminGraphQLClient, no DB, no fetch. The
 * cancel path does not touch the DB at all (pure GQL call), so the
 * `db` arg to the factory can be a stub that throws on any access —
 * which would surface accidental regressions if the implementation ever
 * grows DB I/O without an explicit decision.
 *
 * Standards: coding-standards Rule #5 (no silent failures — every
 * failure mode raises a structured error or returns a structured
 * idempotency signal), Rule #6 (idempotent retry-safety), Rule #9
 * (happy path + edge cases per failure mode).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createFulfillmentPushService,
  ShopifyFulfillmentPushError,
  SHOPIFY_CANCEL_INVALID_INPUT,
  SHOPIFY_CANCEL_USER_ERRORS,
  SHOPIFY_CANCEL_NETWORK_ERROR,
  SHOPIFY_PUSH_CLIENT_NOT_SET,
} from "../../fulfillment-push.service";
import type { ShopifyAdminGraphQLClient } from "../../../shopify/admin-gql-client";

// ─── Fixtures ────────────────────────────────────────────────────────

const FULFILLMENT_GID = "gid://shopify/Fulfillment/55555";

function okCancelResponse(status: string = "CANCELLED") {
  return {
    fulfillmentCancel: {
      fulfillment: { id: FULFILLMENT_GID, status },
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
 * DB stub: cancel path must never touch the DB. Any access throws so a
 * future regression that adds an unexpected query lights up immediately.
 */
function makeDbStub() {
  return {
    execute: vi.fn(() => {
      throw new Error("DB should not be touched by cancelShopifyFulfillment");
    }),
  };
}

// ─── Test suite ──────────────────────────────────────────────────────

describe("cancelShopifyFulfillment :: happy path", () => {
  let db: ReturnType<typeof makeDbStub>;
  let client: MockClient;

  beforeEach(() => {
    db = makeDbStub();
    client = makeShopifyClient([okCancelResponse()]);
  });

  it("issues fulfillmentCancel mutation with the GID and returns alreadyCancelled:false", async () => {
    const svc = createFulfillmentPushService(db as any, null);
    svc.setShopifyClient(client);

    const result = await svc.cancelShopifyFulfillment(FULFILLMENT_GID);

    expect(result).toEqual({
      fulfillmentGid: FULFILLMENT_GID,
      alreadyCancelled: false,
    });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].query).toContain("fulfillmentCancel");
    expect(client.calls[0].query).toContain("$id: ID!");
    expect(client.calls[0].query).toContain("userErrors");
    expect(client.calls[0].variables).toEqual({ id: FULFILLMENT_GID });
    // No DB I/O on cancel path.
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("accepts opts.notifyCustomer without altering the mutation variables", async () => {
    const svc = createFulfillmentPushService(db as any, null);
    svc.setShopifyClient(client);

    // Default true (Overlord D10) and explicit false are both accepted.
    const result = await svc.cancelShopifyFulfillment(FULFILLMENT_GID, {
      notifyCustomer: false,
    });

    expect(result.alreadyCancelled).toBe(false);
    // Shopify's fulfillmentCancel(id: ID!) takes no notifyCustomer — the
    // variables block must contain only `id`, regardless of the opt value.
    expect(client.calls[0].variables).toEqual({ id: FULFILLMENT_GID });
    expect(Object.keys(client.calls[0].variables ?? {})).toEqual(["id"]);
  });

  it("logs a success line that includes the returned fulfillment status", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const svc = createFulfillmentPushService(db as any, null);
    svc.setShopifyClient(client);

    await svc.cancelShopifyFulfillment(FULFILLMENT_GID);

    const matched = logSpy.mock.calls
      .map((args) => String(args[0] ?? ""))
      .some(
        (line) =>
          line.includes("[cancelShopifyFulfillment]") &&
          line.includes(FULFILLMENT_GID) &&
          line.includes("CANCELLED"),
      );
    expect(matched).toBe(true);
    logSpy.mockRestore();
  });
});

describe("cancelShopifyFulfillment :: idempotency", () => {
  let db: ReturnType<typeof makeDbStub>;

  beforeEach(() => {
    db = makeDbStub();
  });

  const idempotentMessages = [
    "Fulfillment is already cancelled.",
    "Fulfillment is already canceled.", // US spelling
    "Fulfillment is in CANCELLED state.",
    "Fulfillment is in canceled state.",
    "fulfillment is already cancelled by someone else", // mixed case + extra text
  ];

  for (const message of idempotentMessages) {
    it(`returns alreadyCancelled:true for userError "${message}"`, async () => {
      const client = makeShopifyClient([
        {
          fulfillmentCancel: {
            fulfillment: null,
            userErrors: [{ field: ["id"], message }],
          },
        },
      ]);
      const svc = createFulfillmentPushService(db as any, null);
      svc.setShopifyClient(client);

      const result = await svc.cancelShopifyFulfillment(FULFILLMENT_GID);

      expect(result).toEqual({
        fulfillmentGid: FULFILLMENT_GID,
        alreadyCancelled: true,
      });
    });
  }

  it("treats already-cancelled as success even when a non-idempotent error is also present", async () => {
    // If Shopify ever returns multiple userErrors and ANY of them is the
    // idempotent shape, we treat the call as a no-op success — the
    // fulfillment is already in the desired state, which is what the
    // caller (markShipmentVoided) cares about.
    const client = makeShopifyClient([
      {
        fulfillmentCancel: {
          fulfillment: null,
          userErrors: [
            { field: ["id"], message: "Some other warning" },
            { field: ["id"], message: "Fulfillment is already cancelled." },
          ],
        },
      },
    ]);
    const svc = createFulfillmentPushService(db as any, null);
    svc.setShopifyClient(client);

    const result = await svc.cancelShopifyFulfillment(FULFILLMENT_GID);
    expect(result.alreadyCancelled).toBe(true);
  });
});

describe("cancelShopifyFulfillment :: input validation", () => {
  let db: ReturnType<typeof makeDbStub>;

  beforeEach(() => {
    db = makeDbStub();
  });

  it("throws SHOPIFY_CANCEL_INVALID_INPUT for empty string", async () => {
    const svc = createFulfillmentPushService(db as any, null);
    svc.setShopifyClient(makeShopifyClient([]));

    await expect(svc.cancelShopifyFulfillment("")).rejects.toMatchObject({
      name: "ShopifyFulfillmentPushError",
      context: {
        code: SHOPIFY_CANCEL_INVALID_INPUT,
        field: "fulfillmentGid",
        value: "",
      },
    });
  });

  it("throws SHOPIFY_CANCEL_INVALID_INPUT for non-string input", async () => {
    const svc = createFulfillmentPushService(db as any, null);
    svc.setShopifyClient(makeShopifyClient([]));

    // Force a runtime non-string through the public boundary.
    await expect(
      svc.cancelShopifyFulfillment(undefined as unknown as string),
    ).rejects.toBeInstanceOf(ShopifyFulfillmentPushError);
    await expect(
      svc.cancelShopifyFulfillment(null as unknown as string),
    ).rejects.toBeInstanceOf(ShopifyFulfillmentPushError);
    await expect(
      svc.cancelShopifyFulfillment(123 as unknown as string),
    ).rejects.toMatchObject({
      context: { code: SHOPIFY_CANCEL_INVALID_INPUT },
    });
  });

  it("throws SHOPIFY_CANCEL_INVALID_INPUT for wrong-prefix GIDs", async () => {
    const svc = createFulfillmentPushService(db as any, null);
    svc.setShopifyClient(makeShopifyClient([]));

    const wrongPrefixes = [
      "gid://shopify/Order/12345",
      "gid://shopify/FulfillmentOrder/12345",
      "12345",
      "Fulfillment/12345",
      // Trailing slash matters too — we want exactly the canonical form.
      "gid://shopify/fulfillment/12345", // lowercase entity
    ];

    for (const bad of wrongPrefixes) {
      await expect(svc.cancelShopifyFulfillment(bad)).rejects.toMatchObject({
        context: {
          code: SHOPIFY_CANCEL_INVALID_INPUT,
          field: "fulfillmentGid",
          value: bad,
        },
      });
    }
  });

  it("does not call the Shopify client when input is invalid", async () => {
    const client = makeShopifyClient([]);
    const svc = createFulfillmentPushService(db as any, null);
    svc.setShopifyClient(client);

    await expect(svc.cancelShopifyFulfillment("")).rejects.toThrow();
    expect(client.calls).toHaveLength(0);
  });
});

describe("cancelShopifyFulfillment :: client + transport failures", () => {
  let db: ReturnType<typeof makeDbStub>;

  beforeEach(() => {
    db = makeDbStub();
  });

  it("throws SHOPIFY_PUSH_CLIENT_NOT_SET when setShopifyClient was never called", async () => {
    const svc = createFulfillmentPushService(db as any, null);
    // No setShopifyClient(...).

    await expect(
      svc.cancelShopifyFulfillment(FULFILLMENT_GID),
    ).rejects.toMatchObject({
      name: "ShopifyFulfillmentPushError",
      context: {
        code: SHOPIFY_PUSH_CLIENT_NOT_SET,
        field: "fulfillmentGid",
        value: FULFILLMENT_GID,
      },
    });
  });

  it("wraps GQL transport throws as SHOPIFY_CANCEL_NETWORK_ERROR with cause preserved", async () => {
    const client = makeShopifyClient([new Error("ECONNRESET")]);
    const svc = createFulfillmentPushService(db as any, null);
    svc.setShopifyClient(client);

    await expect(
      svc.cancelShopifyFulfillment(FULFILLMENT_GID),
    ).rejects.toMatchObject({
      name: "ShopifyFulfillmentPushError",
      context: {
        code: SHOPIFY_CANCEL_NETWORK_ERROR,
        field: "fulfillmentGid",
        value: FULFILLMENT_GID,
        cause: "ECONNRESET",
      },
    });
  });
});

describe("cancelShopifyFulfillment :: non-idempotent userErrors", () => {
  let db: ReturnType<typeof makeDbStub>;

  beforeEach(() => {
    db = makeDbStub();
  });

  it("throws SHOPIFY_CANCEL_USER_ERRORS with userErrors preserved on context", async () => {
    const userErrors = [
      { field: ["id"], message: "Fulfillment cannot be cancelled at this time." },
    ];
    const client = makeShopifyClient([
      { fulfillmentCancel: { fulfillment: null, userErrors } },
    ]);
    const svc = createFulfillmentPushService(db as any, null);
    svc.setShopifyClient(client);

    await expect(
      svc.cancelShopifyFulfillment(FULFILLMENT_GID),
    ).rejects.toMatchObject({
      name: "ShopifyFulfillmentPushError",
      context: {
        code: SHOPIFY_CANCEL_USER_ERRORS,
        field: "fulfillmentGid",
        value: FULFILLMENT_GID,
        userErrors,
      },
    });
  });

  it("includes all userError messages in the thrown Error.message", async () => {
    const client = makeShopifyClient([
      {
        fulfillmentCancel: {
          fulfillment: null,
          userErrors: [
            { field: ["id"], message: "Fulfillment not found." },
            { field: ["id"], message: "Permission denied." },
          ],
        },
      },
    ]);
    const svc = createFulfillmentPushService(db as any, null);
    svc.setShopifyClient(client);

    let caught: any;
    try {
      await svc.cancelShopifyFulfillment(FULFILLMENT_GID);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ShopifyFulfillmentPushError);
    expect(caught.message).toContain("Fulfillment not found.");
    expect(caught.message).toContain("Permission denied.");
  });
});
