import { describe, expect, it, vi } from "vitest";
import {
  CustomerReturnLabelsService,
  RETURN_LABEL_EXECUTION_WINDOW_MS,
  type CustomerReturnLabelStore,
  type CustomerReturnLabelsDependencies,
  type StoredReturnLabels,
} from "../../application/customer-return-labels.service";
import { labelSettings } from "../support/label-fixtures";
import type { ReturnLabelInput } from "../../../shipping-engine/application/return-label-provider.port";
import {
  returnRateShipmentSchema,
  ReturnRateProviderError,
  type ReturnRateResult,
  type ReturnRateProvider,
} from "../../../shipping-engine/application/return-rate-provider.port";
import type { CustomerReturnQuoteDecision } from "../../application/customer-return-label-quote";
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
  const stored = {
    channelId: 36,
    authorizationId: 1,
    authorizationNumber: "RMA-1",
    parcels: Array.from({ length: count }, (_, index) => ({
      id: index + 1,
      number: index + 1,
      selectionMode: "fixed_service" as const,
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
  } as StoredReturnLabels;
  for (const parcel of stored.parcels) {
    const {
      carrierId: _carrier,
      serviceCode: _service,
      ...shipment
    } = parcel.input!;
    parcel.shipment = returnRateShipmentSchema.parse(shipment);
  }
  const quoteDecisions: CustomerReturnQuoteDecision[] = [];
  const recordQuote = vi.fn<CustomerReturnLabelStore["recordQuote"]>(
    async (_channel, _auth, _parcel, decision) => {
      quoteDecisions.push(structuredClone(decision));
      return quoteDecisions.length;
    },
  );
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
    async (_channel, _auth, parcelId, _actor, now, quoteId) => {
      const parcel = stored.parcels.find((row) => row.id === parcelId)!;
      if (parcel.attempt) return null;
      if (quoteId) {
        const chosen = quoteDecisions[quoteId - 1].selected!;
        parcel.input = {
          ...parcel.shipment,
          carrierId: chosen.carrierId,
          serviceCode: chosen.serviceCode,
        };
      }
      parcel.attempt = {
        id: parcelId,
        status: "executing",
        startedAt: now,
        result: null,
      };
      return { id: parcelId, input: parcel.input! };
    },
  );
  const read = vi.fn(async () => structuredClone(stored));
  const purchase = vi.fn(async (input: ReturnLabelInput) => ({
    ...label,
    externalShipmentId: input.externalShipmentId,
    carrierId: input.carrierId,
    serviceCode: input.serviceCode,
  }));
  const recover = vi.fn(
    async (_input: ReturnLabelInput): Promise<ReturnLabelRecord | null> => ({
      ...label,
    }),
  );
  const authorizeChannel = vi.fn(async () => {});
  const requirePurchaseConfiguration = vi.fn<
    CustomerReturnLabelsDependencies["requirePurchaseConfiguration"]
  >(async () => ({ ...labelSettings, carrierId: "se-3" }));
  const quote = vi.fn<ReturnRateProvider["quote"]>(async () => ({
    status: "completed",
    rates: [],
    exclusions: [],
  }));
  const service = new CustomerReturnLabelsService({
    store: { read, begin, finish, recordQuote },
    provider: { purchase, recover },
    rates: { quote },
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
    quote,
    recordQuote,
    quoteDecisions,
    advance: () => {
      clock = new Date(clock.getTime() + RETURN_LABEL_EXECUTION_WINDOW_MS);
    },
  };
}
describe("durable private return label execution", () => {
  function rate(
    carrierId: string,
    serviceCode: string,
    amountCents: number,
  ): ReturnRateResult["rates"][number] {
    return {
      carrierId,
      carrierCode: carrierId === "se-4" ? "usps" : "ups",
      serviceCode,
      amountCents,
      currency: "USD",
      rateId: null,
      rateType: "quick",
      packageType: null,
      trackable: true,
      validationStatus: "valid",
      warningCount: 0,
      amounts: {
        shippingCents: amountCents,
        insuranceCents: 0,
        confirmationCents: 0,
        otherCents: 0,
      },
    };
  }
  function automatic(count = 1) {
    const s = setup(count);
    for (const parcel of s.stored.parcels) {
      parcel.selectionMode = "cheapest_eligible";
      parcel.input = null;
    }
    s.requirePurchaseConfiguration.mockResolvedValue({
      ...labelSettings,
      selectionMode: "cheapest_eligible",
      carrierId: null,
      serviceCode: null,
      carrierRules: [
        { carrierId: "se-3", serviceCodes: ["ups_ground"], maxWeightLb: null },
        {
          carrierId: "se-4",
          serviceCodes: ["usps_ground_advantage"],
          maxWeightLb: "20",
        },
      ],
    });
    s.quote.mockResolvedValue({
      status: "completed",
      rates: [
        rate("se-3", "ups_ground", 600),
        rate("se-4", "usps_ground_advantage", 400),
      ],
      exclusions: [],
    });
    return s;
  }
  it("quotes each automatic box independently and buys the persisted selected service", async () => {
    const s = automatic(2);
    s.stored.parcels[1].shipment.parcel.weightGrams = 10000;
    await s.service.progress(36, 1, "admin");
    await s.service.progress(36, 1, "admin");
    expect(s.purchase.mock.calls.map(([input]) => input.carrierId)).toEqual([
      "se-4",
      "se-3",
    ]);
    expect(s.quote.mock.calls[0]?.[0]).toMatchObject({
      carrierIds: ["se-3", "se-4"],
    });
    expect(s.quote.mock.calls[1]?.[0]).toMatchObject({ carrierIds: ["se-3"] });
    expect(s.quoteDecisions.map((row) => row.selected?.amountCents)).toEqual([
      400, 600,
    ]);
    expect(s.recordQuote).toHaveBeenCalledTimes(2);
  });
  it("two concurrent quotes still create only one purchase", async () => {
    const s = automatic();
    await Promise.all([
      s.service.progress(36, 1, "a"),
      s.service.progress(36, 1, "b"),
    ]);
    expect(s.purchase).toHaveBeenCalledTimes(1);
    expect(s.quoteDecisions.length).toBeGreaterThan(0);
  });
  it("records a failed quote without purchase intent and permits a later quote", async () => {
    const s = automatic();
    s.quote.mockRejectedValueOnce(
      new ReturnRateProviderError("RETURN_RATE_TIMEOUT", "transient"),
    );
    await expect(s.service.progress(36, 1, "admin")).rejects.toMatchObject({
      code: "RETURN_RATE_TIMEOUT",
    });
    expect(s.begin).not.toHaveBeenCalled();
    expect(s.purchase).not.toHaveBeenCalled();
    expect(s.quoteDecisions[0]).toMatchObject({
      selected: null,
      errorCode: "RETURN_RATE_TIMEOUT",
    });
    await s.service.progress(36, 1, "admin");
    expect(s.purchase).toHaveBeenCalledTimes(1);
  });
  it("records no eligible rate without a terminal attempt or provider purchase", async () => {
    const s = automatic();
    s.quote.mockResolvedValue({
      status: "completed",
      rates: [],
      exclusions: [],
    });
    await expect(s.service.progress(36, 1, "admin")).rejects.toMatchObject({
      code: "RETURN_RATE_NONE_ELIGIBLE",
    });
    expect(s.recordQuote).toHaveBeenCalledTimes(1);
    expect(s.begin).not.toHaveBeenCalled();
    expect(s.purchase).not.toHaveBeenCalled();
  });
  it("keeps later boxes pending after no eligible rate and resumes one box per command after corrected rates", async () => {
    const s = automatic(2);
    s.quote.mockResolvedValueOnce({
      status: "completed",
      rates: [],
      exclusions: [],
    });
    await expect(s.service.progress(36, 1, "admin")).rejects.toMatchObject({
      code: "RETURN_RATE_NONE_ELIGIBLE",
    });
    expect(s.stored.parcels.map((parcel) => parcel.attempt)).toEqual([
      null,
      null,
    ]);
    expect(s.begin).not.toHaveBeenCalled();
    expect(s.purchase).not.toHaveBeenCalled();
    expect(s.quoteDecisions).toHaveLength(1);
    expect(s.quoteDecisions[0]).toMatchObject({
      selected: null,
      errorCode: "RETURN_RATE_NONE_ELIGIBLE",
    });
    const corrected = {
      ...labelSettings,
      selectionMode: "cheapest_eligible" as const,
      version: 2,
      carrierId: null,
      serviceCode: null,
      carrierRules: [
        { carrierId: "se-3", serviceCodes: ["ups_ground"], maxWeightLb: null },
      ],
    };
    s.requirePurchaseConfiguration.mockResolvedValue(corrected);
    s.quote.mockResolvedValue({
      status: "completed",
      rates: [rate("se-3", "ups_ground", 600)],
      exclusions: [],
    });
    expect(
      (await s.service.progress(36, 1, "admin")).parcels.map(
        (parcel) => parcel.status,
      ),
    ).toEqual(["ready", "pending"]);
    expect(s.purchase).toHaveBeenCalledTimes(1);
    expect(
      (await s.service.progress(36, 1, "admin")).parcels.map(
        (parcel) => parcel.status,
      ),
    ).toEqual(["ready", "ready"]);
    await s.service.progress(36, 1, "admin");
    expect(s.purchase).toHaveBeenCalledTimes(2);
    expect(s.quoteDecisions).toHaveLength(3);
    expect(s.quoteDecisions[0]).toMatchObject({
      selected: null,
      errorCode: "RETURN_RATE_NONE_ELIGIBLE",
    });
  });
  it("a changed settings fence after quoting prevents all provider purchases", async () => {
    const s = automatic();
    s.begin.mockRejectedValue(new Error("settings changed"));
    await expect(s.service.progress(36, 1, "admin")).rejects.toThrow(
      "settings changed",
    );
    expect(s.recordQuote).toHaveBeenCalledTimes(1);
    expect(s.purchase).not.toHaveBeenCalled();
  });
  it("recovers an uncertain automatic purchase from its original service without rerating", async () => {
    const s = automatic();
    s.purchase.mockRejectedValueOnce(
      new ReturnLabelProviderError("RETURN_LABEL_TIMEOUT", "unknown"),
    );
    await s.service.progress(36, 1, "admin");
    s.requirePurchaseConfiguration.mockRejectedValue(new Error("paused"));
    s.recover.mockImplementation(async (input) => ({
      ...label,
      carrierId: input.carrierId,
      serviceCode: input.serviceCode,
      externalShipmentId: input.externalShipmentId,
    }));
    expect((await s.service.progress(36, 1, "admin")).parcels[0].status).toBe(
      "ready",
    );
    expect(s.quote).toHaveBeenCalledTimes(1);
    expect(s.purchase).toHaveBeenCalledTimes(1);
    expect(s.recover).toHaveBeenCalledWith(
      expect.objectContaining({
        carrierId: "se-4",
        serviceCode: "usps_ground_advantage",
      }),
    );
  });
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
