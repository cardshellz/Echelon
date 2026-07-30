import { describe, expect, it, vi } from "vitest";

import type {
  CarrierTrackingRepository,
  CarrierTrackingTransaction,
} from "../../carrier-tracking.repository";
import {
  CarrierTrackingService,
  type CarrierTrackingLogger,
} from "../../carrier-tracking.service";
import { ShipStationTrackingEventsError } from "../../shipstation-tracking-events.client";

const now = new Date("2026-07-29T12:00:00.000Z");

function logger(): CarrierTrackingLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function fixture(
  statusDetailCode: string,
  description: string,
  statusCode: "AC" | "IT" = "AC",
  labelPollLeaseOwner: string | null = "label-poll-test",
) {
  const finalizeLabelTrackingPollAttempt = vi
    .fn()
    .mockImplementation(async (input) => ({
      id: 901,
      inserted: true,
      outcome: input.outcome,
    }));
  const enqueueDispatchCommand = vi.fn().mockResolvedValue({
    id: 801,
    inserted: true,
    status: "pending",
  });
  const transaction: CarrierTrackingTransaction = {
    acquireTrackingLock: vi.fn().mockResolvedValue(undefined),
    insertOrGetEvent: vi.fn().mockResolvedValue({ id: 701, inserted: true }),
    findMatchCandidates: vi.fn().mockResolvedValue([
      {
        shippingProviderLabelId: 4159,
        provider: "shipstation",
        providerLabelId: "448530246",
        trackingNumber: "9434650106151112859195",
        normalizedTrackingNumber: "9434650106151112859195",
        labelStatus: "active",
        labelDirection: "outbound",
        linkCount: 1,
        physicalShipmentIds: [1201],
        legacyWmsShipmentIds: [14284],
      },
    ]),
    appendMatchAttempt: vi.fn().mockResolvedValue({
      id: 751,
      inserted: true,
      shippingProviderLabelId: 4159,
    }),
    markEventReconciled: vi.fn().mockResolvedValue(undefined),
    enqueueDispatchCommand,
  };
  const repository = {
    prepareLabelTrackingPolls: vi.fn().mockResolvedValue({
      inserted: 1,
      completed: 0,
      retired: 0,
    }),
    claimLabelTrackingPolls: vi.fn().mockResolvedValue([
      {
        shippingProviderLabelId: 4159,
        providerLabelId: "448530246",
        carrierCode: "stamps_com",
        trackingNumber: "9434650106151112859195",
        normalizedTrackingNumber: "9434650106151112859195",
        attemptNumber: 1,
        consecutiveFailureCount: 0,
        startedAt: new Date(now),
        leaseOwner: "label-poll-test",
        leaseExpiresAt: new Date("2026-07-29T12:10:00.000Z"),
      },
    ]),
    finalizeLabelTrackingPollAttempt,
    transaction: async (work) => work(transaction),
  } as unknown as CarrierTrackingRepository;
  const getLabelTrackingSnapshot = vi.fn().mockResolvedValue({
    httpStatus: 200 as const,
    payload: {
      tracking_number: "9434650106151112859195",
      carrier_code: "stamps_com",
      status_code: statusCode,
      status_detail_code: statusDetailCode,
      events: [
        {
          occurred_at: "2026-07-28T17:39:00.000Z",
          status_detail_code: statusDetailCode,
          description,
        },
      ],
    },
  });
  const service = new CarrierTrackingService({
    repository,
    clock: { now: () => new Date(now) },
    logger: logger(),
    trackingEventsClient: {
      isConfigured: () => true,
      getTrackingSnapshot: vi.fn(),
      getLabelTrackingSnapshot,
    },
    ...(labelPollLeaseOwner === null ? {} : { labelPollLeaseOwner }),
  });
  return {
    service,
    repository,
    finalizeLabelTrackingPollAttempt,
    enqueueDispatchCommand,
    getLabelTrackingSnapshot,
  };
}

describe("CarrierTrackingService exact-label polling", () => {
  it("turns a physical pickup snapshot into the existing dispatch command", async () => {
    const test = fixture("PICKED_UP", "USPS picked up item");

    const result = await test.service.pollShipStationLabels(25);

    expect(result).toMatchObject({
      labelPollsPrepared: 1,
      labelPollsClaimed: 1,
      labelPollsConfirmed: 1,
      labelPollsWaiting: 0,
      errors: 0,
    });
    expect(test.getLabelTrackingSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        providerLabelId: "448530246",
        resourceUrl: "https://api.shipstation.com/v2/labels/se-448530246/track",
      }),
    );
    expect(test.enqueueDispatchCommand).toHaveBeenCalledWith(
      701,
      4159,
      new Date("2026-07-28T17:39:00.000Z"),
      now,
    );
    expect(test.finalizeLabelTrackingPollAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        shippingProviderLabelId: 4159,
        outcome: "confirmed",
        carrierTrackingEventId: 701,
        dispatchEvidence: "confirmed",
        nextAttemptAt: null,
      }),
    );
  });

  it("classifies the in-transit facility shape observed for order #60822 as dispatch", async () => {
    const test = fixture(
      "ARRIVED_AT_FACILITY",
      "Arrived at USPS Regional Facility WARRENDALE PA",
      "IT",
    );

    const result = await test.service.pollShipStationLabels(25);

    expect(result.labelPollsConfirmed).toBe(1);
    expect(test.enqueueDispatchCommand).toHaveBeenCalledOnce();
  });

  it("keeps pre-shipment evidence waiting without advancing fulfillment", async () => {
    const test = fixture(
      "ELEC_ADVICE_RECD_BY_CARRIER",
      "Pre-Shipment Info Sent USPS Awaits Item",
    );

    const result = await test.service.pollShipStationLabels(25);

    expect(result.labelPollsWaiting).toBe(1);
    expect(test.enqueueDispatchCommand).not.toHaveBeenCalled();
    expect(test.finalizeLabelTrackingPollAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "waiting",
        dispatchEvidence: "not_confirmed",
        nextAttemptAt: new Date("2026-07-29T12:15:00.000Z"),
      }),
    );
  });

  it("schedules a bounded retry for a transient provider failure", async () => {
    const test = fixture("PICKED_UP", "USPS picked up item");
    test.getLabelTrackingSnapshot.mockRejectedValueOnce(
      new ShipStationTrackingEventsError(
        "HTTP",
        "ShipStation label tracking returned HTTP 400",
        { status: 400, responseBody: "Service Temporarily Unavailable" },
      ),
    );

    const result = await test.service.pollShipStationLabels(25);

    expect(result.labelPollsRetryScheduled).toBe(1);
    expect(test.enqueueDispatchCommand).not.toHaveBeenCalled();
    expect(test.finalizeLabelTrackingPollAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "retry_scheduled",
        httpStatus: 400,
        nextAttemptAt: new Date("2026-07-29T12:05:00.000Z"),
      }),
    );
  });

  it("rejects a provider response that identifies a different label", async () => {
    const test = fixture("PICKED_UP", "USPS picked up item");
    test.getLabelTrackingSnapshot.mockResolvedValueOnce({
      httpStatus: 200,
      payload: {
        label_id: "se-448530247",
        tracking_number: "9434650106151112859195",
        carrier_code: "stamps_com",
        status_code: "IT",
        events: [],
      },
    });

    const result = await test.service.pollShipStationLabels(25);

    expect(result.labelPollsReviewRequired).toBe(1);
    expect(test.enqueueDispatchCommand).not.toHaveBeenCalled();
    expect(test.finalizeLabelTrackingPollAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "review_required",
        errorCode: "SHIPSTATION_TRACKING_HYDRATION_INVALID_RESPONSE",
        nextAttemptAt: null,
      }),
    );
  });

  it("scopes the default lease owner to the runtime and process", async () => {
    vi.stubEnv("DYNO", "worker.7");
    try {
      const test = fixture(
        "PICKED_UP",
        "USPS picked up item",
        "IT",
        null,
      );

      await test.service.pollShipStationLabels(25);

      expect(test.repository.claimLabelTrackingPolls).toHaveBeenCalledWith(
        25,
        now,
        `carrier-label-poll:worker.7:${process.pid}`,
        new Date("2026-07-29T12:10:00.000Z"),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("retains a permanent provider failure for review", async () => {
    const test = fixture("PICKED_UP", "USPS picked up item");
    test.getLabelTrackingSnapshot.mockRejectedValueOnce(
      new ShipStationTrackingEventsError(
        "HTTP",
        "ShipStation label tracking returned HTTP 401",
        { status: 401 },
      ),
    );

    const result = await test.service.pollShipStationLabels(25);

    expect(result.labelPollsReviewRequired).toBe(1);
    expect(test.enqueueDispatchCommand).not.toHaveBeenCalled();
    expect(test.finalizeLabelTrackingPollAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "review_required",
        httpStatus: 401,
        nextAttemptAt: null,
      }),
    );
  });
});
