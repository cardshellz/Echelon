import { describe, expect, it, vi } from "vitest";

import {
  loadTrackingEnrollmentPreview,
  parseFlags,
  runTrackingEnrollment,
  type TrackingEnrollmentDependencies,
  type TrackingEnrollmentPreview,
} from "../enroll-shipstation-carrier-tracking";
import type { CarrierTrackingSubscriptionSweepResult } from "../../server/modules/shipping/carrier-tracking.service";

const preview: TrackingEnrollmentPreview = {
  activeOrUnknownLabels: 10,
  labelsMissingCarrierCode: 1,
  labelsMissingSubscriptionLink: 4,
  subscriptionsByStatus: { active: 5 },
  dueSubscriptions: 0,
  reviewFailures: [],
};

function sweep(overrides: Partial<CarrierTrackingSubscriptionSweepResult> = {}) {
  return {
    subscriptionsPrepared: 0,
    subscriptionLabelLinksPrepared: 0,
    subscriptionsClaimed: 0,
    subscriptionsActivated: 0,
    subscriptionsRetryScheduled: 0,
    subscriptionsReviewRequired: 0,
    subscriptionClientConfigured: true,
    errors: 0,
    ...overrides,
  } satisfies CarrierTrackingSubscriptionSweepResult;
}

function dependencies(
  configured = true,
  results: CarrierTrackingSubscriptionSweepResult[] = [],
): TrackingEnrollmentDependencies {
  return {
    preview: vi.fn().mockResolvedValue(preview),
    isProviderConfigured: () => configured,
    sweep: vi.fn().mockImplementation(async () => results.shift() ?? sweep()),
    sleep: vi.fn().mockResolvedValue(undefined),
    log: vi.fn(),
  };
}

describe("ShipStation carrier tracking enrollment script", () => {
  it("defaults to a bounded, read-only dry run", () => {
    expect(parseFlags([])).toEqual({
      help: false,
      mode: "dry-run",
      limit: 25,
      batches: 1,
      batchDelayMs: 1_000,
      json: false,
    });
  });

  it("rejects conflicting modes and out-of-range provider batches", () => {
    expect(() => parseFlags(["--dry-run", "--execute"])).toThrow(/either/);
    expect(() => parseFlags(["--limit=101"])).toThrow(/1 through 100/);
    expect(() => parseFlags(["--batches=0"])).toThrow(/1 through 100/);
  });

  it("does not write or call the provider during dry run", async () => {
    const deps = dependencies(false);
    const result = await runTrackingEnrollment(parseFlags([]), deps);

    expect(deps.sweep).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      mode: "dry-run",
      batchesRun: 0,
      stoppedReason: "dry_run",
      before: preview,
      after: null,
    });
  });

  it("reports exact grouped provider failures retained by review attempts", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [{
        active_or_unknown_labels: 10,
        labels_missing_carrier_code: 0,
        labels_missing_subscription_link: 4,
      }],
    }).mockResolvedValueOnce({
      rows: [{
        subscription_status: "review",
        status_count: 3,
        due_count: 0,
      }],
    }).mockResolvedValueOnce({
      rows: [{
        carrier_code: "stamps_com",
        last_error_code: "SHIPSTATION_TRACKING_HTTP",
        last_error_message: "ShipStation tracking subscription returned HTTP 400",
        http_status: 400,
        response_body: "Invalid carrier_code",
        subscription_count: 3,
      }],
    });

    await expect(loadTrackingEnrollmentPreview({ query })).resolves.toEqual({
      activeOrUnknownLabels: 10,
      labelsMissingCarrierCode: 0,
      labelsMissingSubscriptionLink: 4,
      subscriptionsByStatus: { review: 3 },
      dueSubscriptions: 0,
      reviewFailures: [{
        carrierCode: "stamps_com",
        errorCode: "SHIPSTATION_TRACKING_HTTP",
        errorMessage: "ShipStation tracking subscription returned HTTP 400",
        httpStatus: 400,
        responseBody: "Invalid carrier_code",
        subscriptionCount: 3,
      }],
    });
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[2][0]).toContain(
      "MIN(subscription.last_error_message) AS last_error_message",
    );
    expect(query.mock.calls[2][0]).toContain(
      "MIN(latest.response_body) AS response_body",
    );
    expect(query.mock.calls[2][0]).not.toContain(
      "subscription.last_error_message,\n      latest.http_status,\n      latest.response_body",
    );
  });

  it("fails before database mutation when execute mode lacks provider configuration", async () => {
    const deps = dependencies(false);

    await expect(runTrackingEnrollment(parseFlags(["--execute"]), deps))
      .rejects.toThrow(/SHIPSTATION_V2_API_KEY/);
    expect(deps.sweep).not.toHaveBeenCalled();
  });

  it("aggregates bounded batches and stops when no due work remains", async () => {
    const deps = dependencies(true, [
      sweep({
        subscriptionsPrepared: 2,
        subscriptionLabelLinksPrepared: 2,
        subscriptionsClaimed: 2,
        subscriptionsActivated: 2,
      }),
      sweep(),
    ]);
    const flags = parseFlags([
      "--execute",
      "--limit=10",
      "--batches=5",
      "--batch-delay-ms=0",
    ]);

    const result = await runTrackingEnrollment(flags, deps);

    expect(deps.sweep).toHaveBeenNthCalledWith(1, 10);
    expect(deps.sweep).toHaveBeenNthCalledWith(2, 10);
    expect(result).toMatchObject({
      batchesRun: 2,
      stoppedReason: "no_due_work",
      summary: {
        subscriptionsPrepared: 2,
        subscriptionLabelLinksPrepared: 2,
        subscriptionsClaimed: 2,
        subscriptionsActivated: 2,
      },
    });
  });
});
