import { describe, expect, it, vi } from "vitest";

import {
  loadTrackingReviewPreview,
  parseFlags,
  runTrackingReviewRequeue,
} from "../requeue-shipstation-carrier-tracking-reviews";

describe("ShipStation tracking subscription review requeue", () => {
  it("defaults to dry-run and requires an exact error code", () => {
    expect(() => parseFlags([])).toThrow(/--error-code is required/);
    expect(parseFlags(["--error-code=SHIPSTATION_TRACKING_HTTP"])).toMatchObject({
      mode: "dry-run",
      errorCode: "SHIPSTATION_TRACKING_HTTP",
      carrierCode: null,
      httpStatus: null,
      limit: 100,
    });
  });

  it("requires guarded audit fields in execute mode", () => {
    expect(() => parseFlags([
      "--execute",
      "--error-code=SHIPSTATION_TRACKING_HTTP",
    ])).toThrow(/--confirm-count/);
  });

  it("loads a bounded preview with retained provider evidence", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ candidate_count: 2 }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 11,
          carrier_code: "stamps_com",
          tracking_number: "9400111222333",
          last_error_code: "SHIPSTATION_TRACKING_HTTP",
          last_error_message: "ShipStation tracking subscription returned HTTP 400",
          http_status: 400,
          response_body: "Invalid carrier_code",
        }],
      });
    const flags = parseFlags([
      "--error-code=SHIPSTATION_TRACKING_HTTP",
      "--http-status=400",
      "--limit=25",
    ]);

    await expect(loadTrackingReviewPreview({ query }, flags)).resolves.toEqual({
      candidateCount: 2,
      selectedCount: 2,
      sample: [{
        id: 11,
        carrierCode: "stamps_com",
        trackingNumber: "9400111222333",
        errorCode: "SHIPSTATION_TRACKING_HTTP",
        errorMessage: "ShipStation tracking subscription returned HTTP 400",
        httpStatus: 400,
        responseBody: "Invalid carrier_code",
      }],
    });
  });

  it("does not mutate during dry-run", async () => {
    const requeueReviewedTrackingSubscriptions = vi.fn();
    const preview = { candidateCount: 2, selectedCount: 2, sample: [] };
    const result = await runTrackingReviewRequeue(
      parseFlags(["--error-code=SHIPSTATION_TRACKING_HTTP"]),
      {
        preview: vi.fn().mockResolvedValue(preview),
        repository: { requeueReviewedTrackingSubscriptions },
        now: () => new Date("2026-07-24T12:00:00.000Z"),
      },
    );
    expect(result).toEqual({ mode: "dry-run", preview, result: null });
    expect(requeueReviewedTrackingSubscriptions).not.toHaveBeenCalled();
  });

  it("rejects execution when the current selection differs from confirmation", async () => {
    const flags = parseFlags([
      "--execute",
      "--error-code=SHIPSTATION_TRACKING_HTTP",
      "--confirm-count=2",
      "--operator=owner@cardshellz.com",
      "--reason=corrected-provider-configuration",
      "--idempotency-key=tracking-repair-batch-1",
    ]);
    const requeueReviewedTrackingSubscriptions = vi.fn();
    await expect(runTrackingReviewRequeue(flags, {
      preview: vi.fn().mockResolvedValue({
        candidateCount: 3,
        selectedCount: 3,
        sample: [],
      }),
      repository: { requeueReviewedTrackingSubscriptions },
      now: () => new Date("2026-07-24T12:00:00.000Z"),
    })).rejects.toThrow(/does not match/);
    expect(requeueReviewedTrackingSubscriptions).not.toHaveBeenCalled();
  });
});
