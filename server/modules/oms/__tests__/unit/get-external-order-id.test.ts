/**
 * Unit tests for `getExternalOrderId` (C39 — GID → numeric normalizer).
 *
 * The shopify-bridge path stores numeric IDs (shopify_orders.id). The
 * webhook path previously stored GID (`gid://shopify/Order/123`) when
 * `admin_graphql_api_id` was present, creating duplicate OMS rows
 * (~470 historical). This normalizer ensures the webhook path always
 * returns numeric format.
 */

import { describe, it, expect, vi } from "vitest";

// `oms-webhooks.ts` imports the shared db module which throws on missing
// connection-string env. We don't touch the db in these tests; provide a
// stub URL via vi.hoisted so it lands BEFORE module imports are
// evaluated. (Safe — no query is ever issued.)
vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgres://stub:stub@localhost:5432/stub";
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getExternalOrderId } = await import("../../oms-webhooks");

describe("getExternalOrderId", () => {
  it("strips GID prefix from admin_graphql_api_id", () => {
    const order = { admin_graphql_api_id: "gid://shopify/Order/12018639536287" };
    expect(getExternalOrderId(order)).toBe("12018639536287");
  });

  it("returns numeric id when admin_graphql_api_id is non-GID (already numeric)", () => {
    const order = { admin_graphql_api_id: "999888777" };
    expect(getExternalOrderId(order)).toBe("999888777");
  });

  it("falls back to id when admin_graphql_api_id is absent", () => {
    const order = { id: "456789" };
    expect(getExternalOrderId(order)).toBe("456789");
  });

  it("prefers admin_graphql_api_id over id when both present (GID normalized)", () => {
    const order = {
      admin_graphql_api_id: "gid://shopify/Order/111",
      id: "222",
    };
    expect(getExternalOrderId(order)).toBe("111");
  });

  it("trims whitespace from the value", () => {
    const order = { admin_graphql_api_id: "  gid://shopify/Order/333  " };
    expect(getExternalOrderId(order)).toBe("333");
  });

  it("coerces numeric id (number type) to string", () => {
    const order = { id: 42 };
    expect(getExternalOrderId(order)).toBe("42");
  });

  it("throws when payload has no admin_graphql_api_id or id", () => {
    const order = { name: "#1001" };
    expect(() => getExternalOrderId(order)).toThrow(
      "getExternalOrderId: missing admin_graphql_api_id and id on payload",
    );
  });

  it("throws on empty object payload", () => {
    expect(() => getExternalOrderId({})).toThrow(
      "getExternalOrderId: missing admin_graphql_api_id and id on payload",
    );
  });

  it("throws when id is null", () => {
    const order = { admin_graphql_api_id: null, id: null };
    expect(() => getExternalOrderId(order)).toThrow(
      "getExternalOrderId: missing admin_graphql_api_id and id on payload",
    );
  });

  it("throws when admin_graphql_api_id is undefined and id is undefined", () => {
    const order = { admin_graphql_api_id: undefined, id: undefined };
    expect(() => getExternalOrderId(order)).toThrow(
      "getExternalOrderId: missing admin_graphql_api_id and id on payload",
    );
  });
});
