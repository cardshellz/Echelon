import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ChannelInventoryApiError,
  ENDPOINTS,
  buildIdentityDraftRequest,
  buildPolicyDraftRequest,
  buildSupplyDraftRequest,
  describeError,
  normalizeNote,
} from "../api";
import { HASH_A, policyHead, policyValue } from "./fixtures";

describe("routine draft requests", () => {
  it("never fabricates a reason: blank notes travel as null", () => {
    expect(normalizeNote("")).toBeNull();
    expect(normalizeNote("   \n ")).toBeNull();
    expect(normalizeNote("  moved CA stock  ")).toBe("moved CA stock");
  });

  it("builds a first-time policy draft with revision 0 and no expected draft", () => {
    const request = buildPolicyDraftRequest({
      scope: { scopeType: "channel", channelId: 3 },
      value: policyValue({ shareBps: 5_000 }),
      head: null,
      note: "",
      idempotencyKey: "key-1",
    });
    expect(request).toMatchObject({
      expectedHeadRevision: "0",
      expectedDraftPolicyId: null,
      expectedDraftDefinitionHash: null,
      changeReason: null,
      idempotencyKey: "key-1",
    });
  });

  it("pins an existing draft by id and hash so a stale edit cannot overwrite someone else's save", () => {
    const head = policyHead({
      scopeKey: "channel:3", channelId: 3, scope: { scopeType: "channel", channelId: 3 },
      draft: policyValue({ shareBps: 4_000 }), revision: "7",
    });
    const request = buildPolicyDraftRequest({
      scope: { scopeType: "channel", channelId: 3 }, value: policyValue({ shareBps: 5_000 }), head, note: "note", idempotencyKey: "k",
    });
    expect(request).toMatchObject({ expectedHeadRevision: "7", expectedDraftPolicyId: 2, changeReason: "note" });
    expect(request.expectedDraftDefinitionHash).toHaveLength(64);
  });

  it("sends supply node ids in canonical order and identities trimmed with optional SKU as null", () => {
    expect(buildSupplyDraftRequest({ publicationTargetId: 5, fulfillmentNodeIds: [8, 7], head: null, note: "", idempotencyKey: "k" }))
      .toMatchObject({ fulfillmentNodeIds: [7, 8], expectedHeadRevision: "0", changeReason: null });
    expect(buildIdentityDraftRequest({
      publicationTargetId: 5, productVariantId: 101, externalInventoryItemId: " item-1 ", externalSku: "  ", head: null, note: "", idempotencyKey: "k",
    })).toMatchObject({ externalInventoryItemId: "item-1", externalSku: null });
  });

  it("rejects malformed input before any request leaves the browser", () => {
    expect(() => buildSupplyDraftRequest({ publicationTargetId: 5, fulfillmentNodeIds: [], head: null, note: "", idempotencyKey: "k" })).toThrow();
    expect(() => buildIdentityDraftRequest({
      publicationTargetId: 5, productVariantId: 101, externalInventoryItemId: "", externalSku: "", head: null, note: "", idempotencyKey: "k",
    })).toThrow();
  });
});

describe("error classification", () => {
  it("maps HTTP status to an operator-facing outcome", () => {
    expect(describeError(new ChannelInventoryApiError(409, "X_STALE", "changed")).kind).toBe("conflict");
    expect(describeError(new ChannelInventoryApiError(400, "X_INVALID", "bad", ["shareBps: too big"])).kind).toBe("validation");
    expect(describeError(new ChannelInventoryApiError(403, "X_FORBIDDEN", "no")).kind).toBe("forbidden");
    expect(describeError(new ChannelInventoryApiError(404, "X_MISSING", "gone")).kind).toBe("not_found");
    expect(describeError(new ChannelInventoryApiError(503, "X_DOWN", "later")).kind).toBe("unavailable");
    expect(describeError(new Error("boom"))).toMatchObject({ kind: "unknown", message: "boom" });
  });
});

describe("endpoints match the server routes", () => {
  const routes = readFileSync("server/modules/inventory-planning/interfaces/http/inventory-channel-exposure.routes.ts", "utf8");
  const globalControl = readFileSync("server/modules/inventory-planning/interfaces/http/inventory-publication-global-control.routes.ts", "utf8");
  const shadow = readFileSync("server/modules/inventory-planning/interfaces/http/inventory-availability-shadow.routes.ts", "utf8");
  const channels = readFileSync("server/modules/channels/channels.routes.ts", "utf8");

  it("uses only registered paths", () => {
    for (const path of [ENDPOINTS.view, ENDPOINTS.preview, ENDPOINTS.policyDraft, ENDPOINTS.sourceBindingDraft,
      ENDPOINTS.variantMappingDraft, ENDPOINTS.target, ENDPOINTS.targetPreviewState, ENDPOINTS.targetStop,
      ENDPOINTS.targetResumeReview, ENDPOINTS.targetResume]) {
      expect(routes).toContain(`"${path}"`);
    }
    expect(globalControl).toContain(`"${ENDPOINTS.globalControl}"`);
    expect(shadow).toContain('"/api/inventory-planning/admin/supply-transformations/:productId/shadow-runs"');
    expect(ENDPOINTS.shadowRuns(10)).toBe("/api/inventory-planning/admin/supply-transformations/10/shadow-runs");
    expect(channels).toContain('"/api/channels/:id/shopify-locations"');
    expect(ENDPOINTS.shopifyLocations(3)).toBe("/api/channels/3/shopify-locations");
  });
});
