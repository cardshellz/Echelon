import { describe, expect, it, vi } from "vitest";
import {
  CustomerReturnLabelsService,
  RETURN_LABEL_EXECUTION_WINDOW_MS,
  type CustomerReturnLabelStore,
  type StoredReturnLabels,
} from "../../application/customer-return-labels.service";
import {
  ReturnLabelProviderError,
  type ReturnLabelRecord,
} from "../../../shipping-engine/application/return-label-provider.port";

const NOW = new Date("2026-09-26T12:00:00Z");
const address = {
  name: "Test",
  addressLine1: "1 Test St",
  city: "Austin",
  state: "TX",
  postalCode: "78701",
  countryCode: "US",
};
const label: ReturnLabelRecord = {
  labelId: "se-1",
  shipmentId: "se-2",
  externalShipmentId: "ecr-1-1",
  trackingNumber: "TRACK1",
  carrierId: "se-3",
  serviceCode: "ups_ground",
  amountCents: 501,
  currency: "USD",
  labelFormat: "pdf",
  downloadUrl: "https://api.shipstation.com/v2/downloads/1/label.pdf",
  createdAt: NOW.toISOString(),
};
function setup(count = 1) {
  let clock = new Date(NOW);
  const stored: StoredReturnLabels = {
    channelId: 36,
    authorizationId: 1,
    authorizationNumber: "RMA-1",
    parcels: Array.from({ length: count }, (_, index) => ({
      id: index + 1,
      number: index + 1,
      input: {
        externalShipmentId: `ecr-1-${index + 1}`,
        rmaNumber: "RMA-1",
        carrierId: "se-3",
        serviceCode: "ups_ground",
        shipFrom: { ...address },
        shipTo: { ...address },
        parcel: {
          weightGrams: 20,
          dimensionsInches: { length: 6, width: 5, height: 4 },
        },
      },
      attempt: null,
    })),
  };
  const finish = vi.fn<CustomerReturnLabelStore["finish"]>(
    async (attemptId, outcome, _actor, now) => {
      const attempt = stored.parcels.find(
        (row) => row.attempt?.id === attemptId,
      )!.attempt!;
      if (attempt.status === "succeeded" || attempt.status === "failed") return;
      attempt.status = outcome.status;
      attempt.result = outcome.status === "succeeded" ? outcome.result : null;
    },
  );
  const begin = vi.fn<CustomerReturnLabelStore["begin"]>(
    async (_channel, _auth, parcelId, _actor, now) => {
      const parcel = stored.parcels.find((row) => row.id === parcelId)!;
      if (parcel.attempt) return null;
      parcel.attempt = {
        id: parcelId,
        status: "executing",
        startedAt: now,
        result: null,
      };
      return parcelId;
    },
  );
  const read = vi.fn(async () => structuredClone(stored));
  const purchase = vi.fn(
    async (input: StoredReturnLabels["parcels"][number]["input"]) => ({
      ...label,
      externalShipmentId: input.externalShipmentId,
    }),
  );
  const recover = vi.fn(
    async (
      _input: StoredReturnLabels["parcels"][number]["input"],
    ): Promise<ReturnLabelRecord | null> => ({ ...label }),
  );
  const authorizeChannel = vi.fn(async () => {});
  const requirePurchaseConfiguration = vi.fn(async () => {});
  const service = new CustomerReturnLabelsService({
    store: { read, begin, finish },
    provider: { purchase, recover },
    authorizeChannel,
    requirePurchaseConfiguration,
    now: () => new Date(clock),
  });
  return {
    service,
    stored,
    read,
    begin,
    finish,
    purchase,
    recover,
    authorizeChannel,
    requirePurchaseConfiguration,
    advance: () => {
      clock = new Date(clock.getTime() + RETURN_LABEL_EXECUTION_WINDOW_MS);
    },
  };
}
describe("durable private return label execution", () => {
  it("commits an attempt before purchase and exposes only authorized artifact paths", async () => {
    const s = setup();
    s.purchase.mockImplementation(async () => {
      expect(s.stored.parcels[0].attempt?.status).toBe("executing");
      return label;
    });
    const result = await s.service.progress(36, 1, "admin");
    expect(result.parcels[0]).toMatchObject({
      status: "ready",
      trackingNumber: "TRACK1",
      downloadPath: expect.stringMatching(/^\/api\/returns\/admin\//),
    });
    expect(JSON.stringify(result)).not.toContain("amountCents");
    expect(JSON.stringify(result)).not.toContain("shipstation.com");
    expect(await s.service.artifact(36, 1, 1)).toEqual(label);
  });
  it("concurrent progress commands purchase one parcel once", async () => {
    const s = setup();
    await Promise.all([
      s.service.progress(36, 1, "one"),
      s.service.progress(36, 1, "two"),
    ]);
    expect(s.purchase).toHaveBeenCalledTimes(1);
    await s.service.progress(36, 1, "three");
    expect(s.purchase).toHaveBeenCalledTimes(1);
  });
  it("a lost provider response permits only recovery GET, including zero matches", async () => {
    const s = setup();
    s.purchase.mockRejectedValue(
      new ReturnLabelProviderError("RETURN_LABEL_TIMEOUT", "unknown"),
    );
    expect((await s.service.progress(36, 1, "admin")).parcels[0].status).toBe(
      "needs_review",
    );
    s.recover.mockResolvedValue(null);
    expect((await s.service.progress(36, 1, "admin")).parcels[0].status).toBe(
      "needs_review",
    );
    s.recover.mockResolvedValue(label);
    expect((await s.service.progress(36, 1, "admin")).parcels[0].status).toBe(
      "ready",
    );
    expect(s.purchase).toHaveBeenCalledTimes(1);
    expect(s.recover).toHaveBeenCalledTimes(2);
  });
  it("database failure after purchase retains executing intent until read-only recovery", async () => {
    const s = setup();
    s.finish.mockRejectedValueOnce(new Error("commit response lost"));
    await expect(s.service.progress(36, 1, "admin")).rejects.toThrow();
    expect((await s.service.progress(36, 1, "admin")).parcels[0].status).toBe(
      "processing",
    );
    s.advance();
    expect((await s.service.progress(36, 1, "admin")).parcels[0].status).toBe(
      "ready",
    );
    expect(s.purchase).toHaveBeenCalledTimes(1);
    expect(s.recover).toHaveBeenCalledTimes(1);
  });
  it("a definitive rejection is never automatically repurchased", async () => {
    const s = setup();
    s.purchase.mockRejectedValue(
      new ReturnLabelProviderError("RETURN_LABEL_HTTP_ERROR", "rejected"),
    );
    expect((await s.service.progress(36, 1, "admin")).parcels[0].status).toBe(
      "failed",
    );
    await s.service.progress(36, 1, "admin");
    expect(s.purchase).toHaveBeenCalledTimes(1);
    expect(s.recover).not.toHaveBeenCalled();
  });
  it("invalid or mismatched provider output never becomes a ready label", async () => {
    const s = setup();
    s.purchase.mockResolvedValue({ ...label, externalShipmentId: "different" });
    expect((await s.service.progress(36, 1, "admin")).parcels[0].status).toBe(
      "needs_review",
    );
    await expect(s.service.artifact(36, 1, 1)).rejects.toMatchObject({
      code: "RETURN_LABEL_NOT_READY",
    });
  });
  it("an explicit check resolves uncertainty before buying a pending box", async () => {
    const s = setup(2);
    s.purchase.mockRejectedValueOnce(
      new ReturnLabelProviderError("RETURN_LABEL_TIMEOUT", "unknown"),
    );
    await s.service.progress(36, 1, "admin");
    expect(
      (await s.service.progress(36, 1, "admin")).parcels.map(
        (row) => row.status,
      ),
    ).toEqual(["ready", "pending"]);
    expect(s.purchase).toHaveBeenCalledTimes(1);
    expect(
      (await s.service.progress(36, 1, "admin")).parcels.map(
        (row) => row.status,
      ),
    ).toEqual(["ready", "ready"]);
    expect(s.purchase).toHaveBeenCalledTimes(2);
    expect(await s.service.artifact(36, 1, 2)).toMatchObject({
      externalShipmentId: "ecr-1-2",
    });
  });
  it("paused settings stop new purchases but allow recovery and saved downloads", async () => {
    const s = setup(2);
    s.purchase.mockRejectedValueOnce(
      new ReturnLabelProviderError("RETURN_LABEL_TIMEOUT", "unknown"),
    );
    await s.service.progress(36, 1, "admin");
    s.requirePurchaseConfiguration.mockRejectedValue(new Error("paused"));
    expect(
      (await s.service.progress(36, 1, "admin")).parcels.map(
        (row) => row.status,
      ),
    ).toEqual(["ready", "pending"]);
    await expect(s.service.progress(36, 1, "admin")).rejects.toThrow("paused");
    expect(await s.service.artifact(36, 1, 1)).toEqual(label);
    expect(s.purchase).toHaveBeenCalledTimes(1);
  });
  it("fresh shop authorization precedes every read, purchase and artifact access", async () => {
    const s = setup();
    s.authorizeChannel.mockRejectedValue(new Error("removed shop"));
    await expect(s.service.status(36, 1)).rejects.toThrow();
    await expect(s.service.progress(36, 1, "admin")).rejects.toThrow();
    await expect(s.service.artifact(36, 1, 1)).rejects.toThrow();
    expect(s.read).not.toHaveBeenCalled();
    expect(s.purchase).not.toHaveBeenCalled();
  });
});
