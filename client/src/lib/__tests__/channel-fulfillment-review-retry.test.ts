import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildFulfillmentReviewPreviewRequest,
  buildFulfillmentReviewRetryRequest,
  fulfillmentReviewBlockerLabel,
  fulfillmentReviewFailureMessage,
  fulfillmentReviewScopeForWorkItem,
  requestFulfillmentReviewRetry,
  type FulfillmentReviewResult,
} from "../channel-fulfillment-review-retry";

const scope = { commandId: 3018, omsOrderId: 831028 };
function preview(): FulfillmentReviewResult {
  return {
    mode: "preview", ...scope, eligibleForRecheck: true, blockers: [],
    stateFingerprint: "a".repeat(64), providerValidation: "not_performed", replayed: false, requeued: false,
    snapshot: {
      ...scope, orderNumber: "#1001", externalOrderId: "08-15140-13597", provider: "ebay",
      trackingNumber: "TRACKING-1001", carrier: "USPS", providerPhysicalShipmentId: "shipment-1",
      status: "review", lastErrorCode: "ebay_fulfillment_idempotency_conflict",
      items: [{ pushItemId: 41, channelOrderLineId: "line-1", sku: "SKU-1", quantity: 3 }],
    },
  };
}
function workItem() {
  return {
    domain: "shipping", code: "channel_fulfillment_review", triageStatus: "needs_attention",
    detailLocator: { sourceTable: "oms.channel_fulfillment_pushes", sourceId: "3018", omsOrderId: "831028" },
  };
}
function response(result: unknown) {
  return new Response(JSON.stringify({ code: "CHANNEL_FULFILLMENT_REVIEW_RETRY", reviewRetry: result }), {
    headers: { "Content-Type": "application/json" },
  });
}

describe("channel fulfillment reviewed-command UI boundary", () => {
  it("extracts only the exact reviewed command's OMS-owned locator", () => {
    expect(fulfillmentReviewScopeForWorkItem(workItem())).toEqual(scope);
    expect(fulfillmentReviewScopeForWorkItem({ ...workItem(), detailLocator: {
      sourceTable: "oms.channel_fulfillment_pushes", sourceId: 3018, omsOrderId: 831028,
    } })).toEqual(scope);
  });
  it.each([
    { domain: "inventory" }, { code: "channel_fulfillment_failed" },
    { code: "historical_shipstation_contents_review" }, { triageStatus: "resolved" },
    { detailLocator: { ...workItem().detailLocator, sourceTable: "wms.shipments" } },
  ])("does not offer the action for another work-item kind or resolved row: %j", (change) => {
    expect(fulfillmentReviewScopeForWorkItem({ ...workItem(), ...change })).toBeNull();
  });
  it.each([undefined, null, "", "0", "-1", "1.1", "3018junk", " 3018", true, 0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1])(
    "rejects malformed command and order identifiers: %j", (invalid) => {
      expect(fulfillmentReviewScopeForWorkItem({ ...workItem(), detailLocator: {
        ...workItem().detailLocator, sourceId: invalid,
      } })).toBeNull();
      expect(fulfillmentReviewScopeForWorkItem({ ...workItem(), detailLocator: {
        ...workItem().detailLocator, omsOrderId: invalid,
      } })).toBeNull();
    },
  );
  it("requires an explicit read-only preview before the minimal fingerprint-bound execution request", () => {
    expect(buildFulfillmentReviewPreviewRequest(scope)).toEqual({
      code: "CHANNEL_FULFILLMENT_REVIEW_RETRY", ...scope, previewOnly: true,
    });
    const evidence = preview();
    const before = structuredClone(evidence);
    expect(buildFulfillmentReviewRetryRequest(scope, evidence, "  Verify after the provider evidence fix.  ")).toEqual({
      code: "CHANNEL_FULFILLMENT_REVIEW_RETRY", ...scope, previewOnly: false,
      expectedStateFingerprint: "a".repeat(64), reason: "Verify after the provider evidence fix.",
    });
    expect(evidence).toEqual(before);
  });
  it.each(["", "   ", "x".repeat(2001)])("requires a bounded, nonblank reason", (reason) => {
    expect(() => buildFulfillmentReviewRetryRequest(scope, preview(), reason)).toThrow();
  });
  it.each([
    { mode: "execute" }, { eligibleForRecheck: false }, { blockers: ["ATTEMPTS_EXHAUSTED"] },
    { replayed: true }, { requeued: true }, { commandId: 3019 }, { omsOrderId: 830992 },
    { stateFingerprint: "not-a-fingerprint" }, { providerValidation: "verified" },
  ])("rejects unusable or mismatched preview before any request: %j", (change) => {
    expect(() => buildFulfillmentReviewRetryRequest(scope, { ...preview(), ...change } as FulfillmentReviewResult, "Reviewed")).toThrow();
  });
  it("also rejects a nested snapshot for another order", () => {
    const wrong = preview();
    wrong.snapshot.omsOrderId = 830992;
    expect(() => buildFulfillmentReviewRetryRequest(scope, wrong, "Reviewed")).toThrow(/different shipment/);
  });
  it("posts only to the existing remediation endpoint and strips unused server evidence", async () => {
    const saved = preview();
    const send = vi.fn(async () => response({ ...saved, snapshot: { ...saved.snapshot, leaseToken: "not-for-ui" } }));
    const body = buildFulfillmentReviewPreviewRequest(scope);
    expect(await requestFulfillmentReviewRetry(body, send)).toEqual(saved);
    expect(send).toHaveBeenCalledExactlyOnceWith("POST", "/api/oms/ops/reconciliation/remediate", body);
  });
  it.each([
    { commandId: 3019 }, { mode: "execute" }, { providerValidation: "performed" },
    { stateFingerprint: "bad" }, { replayed: true }, { requeued: true },
    { eligibleForRecheck: false }, { blockers: ["COMMAND_NOT_IN_REVIEW"] },
  ])("rejects an inconsistent or out-of-scope server response: %j", async (change) => {
    const send = vi.fn(async () => response({ ...preview(), ...change }));
    await expect(requestFulfillmentReviewRetry(buildFulfillmentReviewPreviewRequest(scope), send)).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("accepts authoritative blocked previews without guessing eligibility in the client", async () => {
    const blocked = { ...preview(), eligibleForRecheck: false, blockers: ["REVIEW_REASON_NOT_SUPPORTED"] };
    expect(await requestFulfillmentReviewRetry(buildFulfillmentReviewPreviewRequest(scope), async () => response(blocked))).toEqual(blocked);
  });
  it.each([false, true])("handles execution and exact replay without a second request (replayed=%s)", async (replayed) => {
    const result = { ...preview(), mode: "execute", requeued: !replayed, replayed,
      eligibleForRecheck: false, blockers: ["COMMAND_NOT_IN_REVIEW"],
      snapshot: { ...preview().snapshot, status: replayed ? "success" : "pending" } };
    const send = vi.fn(async () => response(result));
    expect(await requestFulfillmentReviewRetry(buildFulfillmentReviewRetryRequest(scope, preview(), "Reviewed"), send)).toEqual(result);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it.each([[false, false], [true, true]])("rejects execution with inconsistent queue/replay flags", async (requeued, replayed) => {
    await expect(requestFulfillmentReviewRetry(buildFulfillmentReviewRetryRequest(scope, preview(), "Reviewed"), async () => response({
      ...preview(), mode: "execute", requeued, replayed,
    }))).rejects.toThrow(/inconsistent/);
  });
  it("does not retry a request with an unknown outcome", async () => {
    const send = vi.fn(async (): Promise<Response> => { throw new Error("Connection interrupted"); });
    await expect(requestFulfillmentReviewRetry(buildFulfillmentReviewRetryRequest(scope, preview(), "Reviewed"), send)).rejects.toThrow("Connection interrupted");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("explains failed previews, stale commands and uncertain execution separately without raw errors", () => {
    expect(fulfillmentReviewFailureMessage(new Error("private database message"), "preview")).toContain("No recheck was requested");
    expect(fulfillmentReviewFailureMessage(new Error("private database message"), "execute")).toContain("outcome could not be confirmed");
    expect(fulfillmentReviewFailureMessage(new Error("409: private detail"), "execute")).toContain("Load a fresh preview");
    expect(fulfillmentReviewFailureMessage(new Error("403: private detail"), "preview")).toContain("permission");
    expect(fulfillmentReviewBlockerLabel("ATTEMPTS_EXHAUSTED")).toContain("retry limit");
    expect(fulfillmentReviewBlockerLabel("NEW_OWNER_BLOCKER")).toContain("NEW_OWNER_BLOCKER");
  });
});

describe("Operations Tower reviewed-command integration contract", () => {
  it("uses the triage permission and resets preview state on a different row/version", () => {
    const source = readFileSync(resolve(process.cwd(), "client/src/pages/FlowMonitor.tsx"), "utf8");
    expect(source).toContain('canTriage={hasPermission("operations", "triage")}');
    expect(source).toContain("props.canTriage ? fulfillmentReviewScopeForWorkItem(item) : null");
    expect(source).toContain("key={`${item.id}:${item.rowVersion}:${item.sourceUpdatedAt}`}");
    expect(source).toContain("onFulfillmentRecheckQueued={invalidateTower}");
    expect(source).toContain("onQueued={props.onFulfillmentRecheckQueued}");
  });
  it("requires a separate reason and confirmation and disables automatic mutation retries", () => {
    const source = readFileSync(resolve(process.cwd(), "client/src/components/operations/ChannelFulfillmentReviewRetryPanel.tsx"), "utf8");
    expect(source.match(/retry: false/g)).toHaveLength(2);
    expect(source).toContain("Preview shipment recheck");
    expect(source).toContain("Reason for recheck (required)");
    expect(source).toContain("Confirm and queue recheck");
    expect(source).toContain("disabled={!canConfirm || !reason.trim() || busy}");
    expect(source).toContain("not a live provider check");
    expect(source).toContain("onError: (error) => {\n      setConfirmOpen(false);\n      setPreview(null);");
  });
});
