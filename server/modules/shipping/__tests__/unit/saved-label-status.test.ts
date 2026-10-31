import { describe, expect, it, vi } from "vitest";
import {
  normalizeSavedLabelStatusObservation,
  verifyHistoricalStatusLabelAlias,
} from "../../saved-label-status.domain";
import { SavedLabelStatusWorker } from "../../saved-label-status.worker";
import {
  complexHistory,
  complexProvider,
} from "../../../returns/__tests__/support/complex-return-scenario";
import { deriveSalesChannelDeliveryEvidence } from "../../sales-channel-delivery.domain";
import {
  SavedLabelStatusSourceError,
  type SavedLabelStatusSourceReader,
} from "../../saved-label-status.source";
import type {
  SavedLabelStatusStore,
  SavedLabelStatusClaim,
} from "../../saved-label-status.repository";

const now = new Date("2026-10-30T12:00:00Z");
const source = {
  kind: "return" as const,
  sourceId: 1,
  providerReference: "se-987",
  trackingNumber: "SYNTHETIC-RETURN-1",
};
const facts = {
  providerReference: source.providerReference,
  trackingNumber: source.trackingNumber,
  carrierCode: "ups",
  serviceCode: "ups_ground",
  direction: "return" as const,
  voided: false,
  voidedAt: null,
};
function fixture() {
  const claim: SavedLabelStatusClaim = {
    ...source,
    id: 10,
    attempt: 1,
    failures: 0,
    token: "00000000-0000-4000-8000-000000000001",
    startedAt: now,
  };
  const store = {
    claim: vi.fn<SavedLabelStatusStore["claim"]>(async () => [claim]),
    settle: vi.fn<SavedLabelStatusStore["settle"]>(async () => true),
  };
  const reader = {
    read: vi.fn<SavedLabelStatusSourceReader["read"]>(async () => ({
      facts,
      snapshot: { tracking_number: source.trackingNumber, status_code: "NY" },
    })),
  };
  const tracking = {
    observeStatusLabel: vi.fn(async () => ({
      shippingProviderLabelId: 9,
      labelInserted: true,
      eventInserted: true,
    })),
    ingestStatusSnapshot: vi.fn(
      async () =>
        ({
          matchStatus: "matched",
          canonicalStatus: "pre_transit",
          eventOccurredAt: now,
        }) as never,
    ),
  };
  const report = vi.fn();
  const channelEvidence = { append: vi.fn(async () => undefined) };
  return {
    claim,
    store,
    reader,
    tracking,
    report,
    channelEvidence,
    worker: new SavedLabelStatusWorker({
      store,
      source: reader,
      channelEvidence,
      tracking,
      report,
      now: () => new Date(now),
      newToken: () => claim.token,
    }),
  };
}
describe("adversarial durable shipping status capture", () => {
  it("retries a failed evidence append before closing capture or advancing delivery", async () => {
    const s=fixture(), provider=complexProvider();
    s.claim.kind="history"; s.claim.sourceId=100; s.claim.providerReference="901"; s.claim.trackingNumber="SYNTHETIC-OUTBOUND-1";
    const historyFacts={...facts,providerReference:"901",trackingNumber:s.claim.trackingNumber,direction:"outbound" as const};
    const channelEvidence=deriveSalesChannelDeliveryEvidence(complexHistory(provider),"901",provider,now);
    s.reader.read.mockResolvedValue({facts:historyFacts,snapshot:null,channelEvidence});
    s.channelEvidence.append.mockRejectedValueOnce(new Error("synthetic lost database response"));
    expect((await s.worker.run()).errors).toBe(1);
    expect(s.tracking.observeStatusLabel).not.toHaveBeenCalled();
    expect(s.store.settle).toHaveBeenLastCalledWith(expect.anything(),expect.objectContaining({state:"retry"}),now);
    expect((await s.worker.run()).errors).toBe(0);
    expect(s.channelEvidence.append).toHaveBeenCalledTimes(2);
    expect(s.store.settle).toHaveBeenLastCalledWith(expect.anything(),expect.objectContaining({state:"complete",status:"delivered"}),now);
  });
  it("never gives a return label the original shipment's channel delivery evidence", async () => {
    const s = fixture(),
      provider = complexProvider();
    const channelEvidence = deriveSalesChannelDeliveryEvidence(
      complexHistory(provider),
      "901",
      provider,
      now,
    );
    s.reader.read.mockResolvedValue({ facts, snapshot: null, channelEvidence });
    expect((await s.worker.run()).errors).toBe(1);
    expect(s.channelEvidence.append).not.toHaveBeenCalled();
    expect(s.tracking.observeStatusLabel).not.toHaveBeenCalled();
    expect(s.store.settle).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        state: "review",
        code: "SAVED_LABEL_STATUS_CHANNEL_IDENTITY_MISMATCH",
      }),
      now,
    );
  });
  it("preserves V2 return identity, never invents V1 contents or outbound authority", () => {
    const observed = normalizeSavedLabelStatusObservation(source, facts, now);
    expect(observed).toMatchObject({
      providerLabelId: "se-987",
      labelDirection: "return",
      observationSource: "shipstation_status_observation",
      providerOrderId: null,
      providerOrderKey: null,
    });
    expect(observed.sanitizedPayload).not.toHaveProperty("shipmentItems");
    expect(observed.sanitizedPayload).not.toHaveProperty(
      "sourceObservationHash",
    );
    expect(observed.shipmentContentsEvidence.status).not.toBe("authoritative");
    expect(observed.eventHash).toBe(
      normalizeSavedLabelStatusObservation(
        source,
        facts,
        new Date(now.getTime() + 1000),
      ).eventHash,
    );
  });
  it.each([
    { ...facts, providerReference: "987" },
    { ...facts, trackingNumber: "ANOTHER-LABEL" },
    { ...facts, direction: "outbound" },
  ])("rejects mismatched immutable label facts", (bad) => {
    expect(() =>
      normalizeSavedLabelStatusObservation(source, bad as typeof facts, now),
    ).toThrow();
  });
  it("does not coerce a V2 identity into a historical V1 shipment", () => {
    expect(() =>
      normalizeSavedLabelStatusObservation(
        { ...source, kind: "history" },
        facts,
        now,
      ),
    ).toThrow();
  });
  it("passes only the stable source identity to the provider, not lease fields", async () => {
    const s = fixture();
    await s.worker.run();
    expect(s.reader.read).toHaveBeenCalledExactlyOnceWith(source);
    expect(s.store.settle).toHaveBeenCalledWith(
      s.claim,
      expect.objectContaining({ state: "active", code: null }),
      now,
    );
    expect(s.tracking.observeStatusLabel).toHaveBeenCalledOnce();
  });
  it("finishes a delivered parcel only after the canonical owner matched it", async () => {
    const s = fixture();
    s.tracking.ingestStatusSnapshot.mockResolvedValue({
      matchStatus: "matched",
      canonicalStatus: "delivered",
      eventOccurredAt: now,
    } as never);
    await s.worker.run();
    expect(s.store.settle.mock.calls[0][1]).toMatchObject({
      state: "complete",
      status: "delivered",
      nextAttemptAt: null,
    });
  });
  it.each(["ambiguous", "unmatched"])(
    "keeps %s tracking unresolved, rather than declaring delivery",
    async (matchStatus) => {
      const s = fixture();
      s.tracking.ingestStatusSnapshot.mockResolvedValue({
        matchStatus,
        canonicalStatus: "delivered",
        eventOccurredAt: now,
      } as never);
      await s.worker.run();
      expect(s.store.settle.mock.calls[0][1]).toMatchObject({
        state: "active",
        code: "SAVED_LABEL_STATUS_MATCH_UNRESOLVED",
      });
    },
  );
  it("does not complete from a future-dated delivery", async () => {
    const s = fixture();
    s.tracking.ingestStatusSnapshot.mockResolvedValue({
      matchStatus: "matched",
      canonicalStatus: "delivered",
      eventOccurredAt: new Date(now.getTime() + 86400000),
    } as never);
    await s.worker.run();
    expect(s.store.settle.mock.calls[0][1].state).toBe("active");
  });
  it("retries provider outages with backoff and a stable job identity", async () => {
    const s = fixture();
    s.claim.failures = 3;
    s.reader.read.mockRejectedValue(
      new SavedLabelStatusSourceError("SAVED_LABEL_STATUS_TRANSPORT", true),
    );
    await s.worker.run();
    expect(s.tracking.observeStatusLabel).not.toHaveBeenCalled();
    expect(s.store.settle.mock.calls[0][1]).toMatchObject({
      state: "retry",
      nextAttemptAt: new Date(now.getTime() + 8 * 60000),
    });
  });
  it("does not loop on confirmed identity mismatches or log provider payloads", async () => {
    const s = fixture();
    s.reader.read.mockRejectedValue(
      new SavedLabelStatusSourceError(
        "SAVED_LABEL_STATUS_IDENTITY_MISMATCH",
        false,
      ),
    );
    await s.worker.run();
    expect(s.store.settle.mock.calls[0][1]).toMatchObject({
      state: "review",
      nextAttemptAt: null,
    });
    expect(s.report).toHaveBeenCalledWith({
      code: "SAVED_LABEL_STATUS_IDENTITY_MISMATCH",
      jobId: 10,
      attempt: 1,
    });
  });
  it("reports a lost lease instead of claiming it saved the result", async () => {
    const s = fixture();
    s.store.settle.mockResolvedValue(false);
    expect((await s.worker.run()).completed).toBe(0);
    expect(s.report).toHaveBeenCalledWith({
      code: "SAVED_LABEL_STATUS_LEASE_LOST",
      jobId: 10,
      attempt: 1,
    });
  });
  it("stops polling a physically received parcel without provider calls or fake delivery evidence", async () => {
    const s = fixture();
    s.reader.read.mockResolvedValue({ finished: true });
    await s.worker.run();
    expect(s.tracking.observeStatusLabel).not.toHaveBeenCalled();
    expect(s.tracking.ingestStatusSnapshot).not.toHaveBeenCalled();
    expect(s.store.settle.mock.calls[0][1]).toEqual({
      state: "complete",
      status: "received",
      code: null,
      nextAttemptAt: null,
    });
  });
  it("requires timestamp, direction and tracking proof before joining a V1 shipment to a V2 label", () => {
    const v1 = {
      shipmentId: 123456,
      trackingNumber: "SYNTHETIC-HISTORY",
      isReturnLabel: false,
      createDate: "2026-01-08T08:15:00.125",
    };
    const v2 = {
      label_id: "se-123456",
      tracking_number: "SYNTHETIC-HISTORY",
      is_return_label: false,
      created_at: "2026-01-08T16:15:00.125Z",
    };
    expect(verifyHistoricalStatusLabelAlias(v1, v2)).toMatchObject({
      providerApiLabelId: v2.label_id,
      createdAt: v2.created_at,
    });
    for (const wrong of [
      { ...v2, label_id: "se-another" },
      { ...v2, tracking_number: "REUSED-IN-ANOTHER-YEAR" },
      { ...v2, is_return_label: true },
      { ...v2, created_at: "2026-02-08T16:15:00.125Z" },
    ])
      expect(() => verifyHistoricalStatusLabelAlias(v1, wrong)).toThrow();
    expect(() =>
      verifyHistoricalStatusLabelAlias({ ...v1, createDate: "2026-01-08" }, v2),
    ).toThrow();
  });
});
