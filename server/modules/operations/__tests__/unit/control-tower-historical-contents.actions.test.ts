import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  decideHistoricalContentsReview,
  getHistoricalContentsCorrectionPreview,
  getHistoricalContentsReviewPreview,
} from "../../control-tower-historical-contents.actions";
import { wmsReconciliationSource } from "../../control-tower-v2.sources";

function poolWithWorkItem(overrides: Record<string, unknown> = {}): Pool {
  return {
    query: vi.fn(async () => ({
      rows: [{
        source_namespace: "wms.reconciliation_exceptions",
        source_type: "reconciliation_exception",
        source_key: "501",
        code: "historical_shipstation_contents_review",
        row_version: 3,
        source_status: "open",
        ...overrides,
      }],
    })),
  } as unknown as Pool;
}

describe("Control Tower historical package-content actions", () => {
  it("projects the conflict with recognizable order and tracking context", () => {
    const item = wmsReconciliationSource.projectRow({
      id: 501,
      source: "historical_shipstation_contents_system_recovery",
      classification: "manual_review",
      rule: "historical_shipstation_contents_review",
      status: "open",
      severity: "review",
      wms_order_id: 301,
      wms_shipment_id: 201,
      external_system: "shipstation",
      external_order_ref: "78001",
      external_shipment_ref: "57001",
      external_order_key: null,
      idempotency_key: "historical_shipstation_contents_review:label:41",
      summary: "raw summary",
      details: { trackingNumber: "1ZHISTORICALREVIEW", decision: null },
      first_seen_at: "2026-08-28T12:00:00.000Z",
      last_seen_at: "2026-08-28T12:00:00.000Z",
      occurrence_count: 1,
      updated_at: "2026-08-28T12:00:00.000Z",
      resolved_wms_order_id: 301,
      resolved_wms_shipment_id: 201,
      wms_order_number: "#REVIEW-1001",
      oms_order_id: null,
      channel_order_number: null,
      channel_provider: null,
      tracking_number: "1ZHISTORICALREVIEW",
      shipping_engine: null,
      engine_order_ref: null,
    });

    expect(item).toMatchObject({
      title: "ShipStation and WMS package contents disagree",
      entityRef: "Order #REVIEW-1001",
      ownerTeam: "Shipping",
      summary: "Order #REVIEW-1001 with tracking 1ZHISTORICALREVIEW has different package contents in ShipStation and WMS. No inventory correction has been posted.",
      recommendedAction: expect.stringContaining("Compare the ShipStation and WMS item lists"),
    });
  });

  it("loads review evidence only for the exact projected source contract", async () => {
    const preview = vi.fn(async () => ({ exceptionId: "501" }));

    await expect(getHistoricalContentsReviewPreview({
      pool: poolWithWorkItem(),
      workItemId: 71,
      reviewService: { preview, decide: vi.fn() },
    })).resolves.toEqual({ exceptionId: "501" });
    expect(preview).toHaveBeenCalledWith("501");
  });

  it("rejects unrelated Tower work items before invoking shipping review", async () => {
    const preview = vi.fn();
    await expect(getHistoricalContentsReviewPreview({
      pool: poolWithWorkItem({ code: "some_other_rule" }),
      workItemId: 71,
      reviewService: { preview, decide: vi.fn() },
    })).rejects.toMatchObject({ code: "INVALID_WORK_ITEM_ACTION", statusCode: 409 });
    expect(preview).not.toHaveBeenCalled();
  });

  it("loads correction evidence through the same exact Tower source contract", async () => {
    const preview = vi.fn(async () => ({ exceptionId: "501", correctionPlanHash: "a".repeat(64) }));

    await expect(getHistoricalContentsCorrectionPreview({
      pool: poolWithWorkItem(),
      workItemId: 71,
      correctionPreviewService: { preview },
    })).resolves.toMatchObject({ exceptionId: "501" });
    expect(preview).toHaveBeenCalledWith("501");
  });

  it("requires the current Tower version and forwards the authenticated actor", async () => {
    const decide = vi.fn(async () => ({ exceptionId: "501", status: "acknowledged" }));
    const reviewService = { preview: vi.fn(), decide };

    await expect(decideHistoricalContentsReview({
      pool: poolWithWorkItem(),
      workItemId: 71,
      version: 2,
      actorUserId: "lead-1",
      expectedPreviewEvidenceHash: "a".repeat(64),
      decision: "cannot_prove",
      reason: "The available evidence does not establish either package record.",
      reviewService,
    })).rejects.toMatchObject({ code: "STALE_WORK_ITEM_VERSION", statusCode: 409 });
    expect(decide).not.toHaveBeenCalled();

    await expect(decideHistoricalContentsReview({
      pool: poolWithWorkItem(),
      workItemId: 71,
      version: 3,
      actorUserId: "lead-1",
      expectedPreviewEvidenceHash: "a".repeat(64),
      decision: "cannot_prove",
      reason: "The available evidence does not establish either package record.",
      reviewService,
    })).resolves.toEqual({ exceptionId: "501", status: "acknowledged" });
    expect(decide).toHaveBeenCalledWith({
      exceptionId: "501",
      expectedPreviewEvidenceHash: "a".repeat(64),
      authenticatedActorUserId: "lead-1",
      decision: "cannot_prove",
      reason: "The available evidence does not establish either package record.",
    });
  });
});
