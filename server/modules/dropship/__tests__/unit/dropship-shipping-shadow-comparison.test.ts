import { describe, expect, it } from "vitest";
import type {
  ShippingQuoteEvidenceInput,
  ShippingQuoteEvidenceWriteResult,
  ShippingQuoteEvidenceWriter,
} from "../../../shipping-engine/application/shipping-quote-evidence-writer";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import {
  DropshipShippingShadowComparisonService,
  type DropshipSharedShippingQuoteProvider,
  type DropshipSharedShippingQuoteResult,
  type DropshipShippingShadowQuoteRequest,
} from "../../application/dropship-shipping-shadow-comparison";
import type {
  DropshipShippingQuoteSnapshotRecord,
} from "../../application/dropship-shipping-quote-service";

const now = new Date("2026-07-26T12:00:00.000Z");

describe("DropshipShippingShadowComparisonService", () => {
  it("records matching base and projected vendor charges", async () => {
    const harness = createHarness(quoted(1000));

    await harness.service.compare(snapshot());

    expect(harness.provider.requests).toHaveLength(1);
    expect(harness.provider.requests[0]).toMatchObject({
      legacyQuoteSnapshotId: 77,
      warehouseId: 3,
      destination: { country: "US", region: "PA", postalCode: "16066" },
      packages: [{
        packageSequence: 1,
        weightGrams: 120,
        lengthMm: 200,
        widthMm: 150,
        heightMm: 40,
      }],
    });
    expect(harness.writer.inputs).toHaveLength(1);
    expect(harness.writer.inputs[0]).toMatchObject({
      source: "shadow",
      evidenceKind: "dropship_shipping_rate_comparison",
      evidenceKey: "77",
      metadata: {
        outcome: "match",
        differences: [],
      },
      rates: {
        legacy: {
          baseRateCents: 1000,
          totalShippingCents: 1122,
        },
        shared: {
          baseRateCents: 1000,
          projectedVendorCharge: {
            markupCents: 100,
            insurancePoolCents: 22,
            totalShippingCents: 1122,
          },
        },
      },
    });
    expect(harness.logs).toContainEqual(expect.objectContaining({
      code: "DROPSHIP_SHIPPING_SHADOW_COMPARISON_RECORDED",
      context: expect.objectContaining({ outcome: "match" }),
    }));
  });

  it("records amount differences without changing the legacy snapshot", async () => {
    const legacy = snapshot();
    const harness = createHarness(quoted(900));

    await harness.service.compare(legacy);

    expect(legacy.totalShippingCents).toBe(1122);
    expect(harness.writer.inputs[0]).toMatchObject({
      metadata: {
        outcome: "amount_mismatch",
        differences: [
          "base rate 1000 != 900",
          "vendor charge 1122 != 1009",
        ],
      },
    });
  });

  it("records unavailable shared coverage and warnings", async () => {
    const harness = createHarness({
      status: "unavailable",
      code: "DROPSHIP_SHARED_SHIPPING_STANDARD_RATE_UNAVAILABLE",
      message: "No Standard rate.",
      warnings: ["no active service-level rate covers US PA 16066"],
      routing: { source: "legacy_profile" },
    });

    await harness.service.compare(snapshot());

    expect(harness.writer.inputs[0]).toMatchObject({
      metadata: {
        outcome: "shared_unavailable",
        differences: [
          "DROPSHIP_SHARED_SHIPPING_STANDARD_RATE_UNAVAILABLE: No Standard rate.",
        ],
      },
      rates: {
        shared: {
          status: "unavailable",
          warnings: ["no active service-level rate covers US PA 16066"],
        },
      },
    });
  });

  it("records provider failures instead of throwing into the legacy quote path", async () => {
    const harness = createHarness(new Error("database timeout"));

    await expect(harness.service.compare(snapshot())).resolves.toBeUndefined();

    expect(harness.writer.inputs[0]).toMatchObject({
      metadata: {
        outcome: "shared_error",
        sharedError: { message: "database timeout" },
      },
    });
  });

  it("records invalid legacy payloads without calling the shared provider", async () => {
    const harness = createHarness(quoted(1000));

    await harness.service.compare(snapshot({ quotePayload: { version: 1 } }));

    expect(harness.provider.requests).toHaveLength(0);
    expect(harness.writer.inputs[0]).toMatchObject({
      metadata: {
        outcome: "legacy_snapshot_invalid",
      },
    });
  });

  it("records a missing store connection as invalid legacy evidence", async () => {
    const harness = createHarness(quoted(1000), {
      mode: "all",
      storeConnectionIds: new Set(),
    });

    await harness.service.compare(snapshot({ storeConnectionId: null }));

    expect(harness.provider.requests).toHaveLength(0);
    expect(harness.writer.inputs[0]).toMatchObject({
      metadata: {
        outcome: "legacy_snapshot_invalid",
        differences: [
          "legacy quote snapshot is missing its store connection ID",
        ],
        sharedError: {
          path: "storeConnectionId",
        },
      },
    });
  });

  it("does nothing outside the configured rollout", async () => {
    const harness = createHarness(quoted(1000), {
      mode: "test",
      storeConnectionIds: new Set([999]),
    });

    await harness.service.compare(snapshot());

    expect(harness.provider.requests).toHaveLength(0);
    expect(harness.writer.inputs).toHaveLength(0);
  });
});

function createHarness(
  result: DropshipSharedShippingQuoteResult | Error,
  rolloutPolicy = {
    mode: "test" as const,
    storeConnectionIds: new Set([22]),
  },
) {
  const writer = new FakeEvidenceWriter();
  const provider = new FakeSharedQuoteProvider(result);
  const logs: DropshipLogEvent[] = [];
  const service = new DropshipShippingShadowComparisonService({
    rolloutPolicy,
    sharedQuoteProvider: provider,
    evidenceWriter: writer,
    logger: {
      info: (event) => logs.push(event),
      warn: (event) => logs.push(event),
      error: (event) => logs.push(event),
    },
    clock: { now: () => now },
  });
  return { service, writer, provider, logs };
}

class FakeSharedQuoteProvider implements DropshipSharedShippingQuoteProvider {
  requests: DropshipShippingShadowQuoteRequest[] = [];

  constructor(
    private readonly result: DropshipSharedShippingQuoteResult | Error,
  ) {}

  async quote(
    input: DropshipShippingShadowQuoteRequest,
  ): Promise<DropshipSharedShippingQuoteResult> {
    this.requests.push(input);
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

class FakeEvidenceWriter implements ShippingQuoteEvidenceWriter {
  inputs: ShippingQuoteEvidenceInput[] = [];

  async persistOnce(
    input: ShippingQuoteEvidenceInput,
  ): Promise<ShippingQuoteEvidenceWriteResult> {
    this.inputs.push(input);
    return { snapshotId: 88, created: true };
  }
}

function quoted(
  baseRateCents: number,
): Extract<DropshipSharedShippingQuoteResult, { status: "quoted" }> {
  return {
    status: "quoted",
    baseRateCents,
    currency: "USD",
    serviceLevelCode: "standard",
    rateBookId: 12,
    rateBookCode: "dropship-vendor-default",
    rateTableId: 34,
    resolvedZone: "PA",
    ratedWeightGrams: 120,
    warnings: [],
    routing: {
      source: "legacy_profile",
      mode: "engine_quoted",
    },
  };
}

function snapshot(
  overrides: Partial<DropshipShippingQuoteSnapshotRecord> = {},
): DropshipShippingQuoteSnapshotRecord {
  return {
    quoteSnapshotId: 77,
    vendorId: 10,
    storeConnectionId: 22,
    warehouseId: 3,
    rateTableId: 33,
    destinationCountry: "US",
    destinationPostalCode: "16066",
    currency: "USD",
    idempotencyKey: "quote-shadow-77",
    requestHash: "a".repeat(64),
    packageCount: 1,
    baseRateCents: 1000,
    markupCents: 100,
    insurancePoolCents: 22,
    dunnageCents: 0,
    totalShippingCents: 1122,
    quotePayload: {
      version: 2,
      destination: {
        country: "US",
        region: "PA",
        postalCode: "16066",
      },
      items: [{ productVariantId: 101, quantity: 1 }],
      providers: {
        cartonization: {
          name: "cardshellz-cartonize",
          version: "3.1.0",
        },
        rates: {
          name: "cached_admin_rate_table",
          version: "1",
        },
      },
      packages: [{
        packageSequence: 1,
        items: [{ productVariantId: 101, quantity: 1 }],
        boxId: 4,
        boxCode: "SMALL",
        weightGrams: 120,
        dimensionsMm: {
          length: 200,
          width: 150,
          height: 40,
        },
      }],
      policies: {
        shippingMarkup: {
          id: 7,
          source: "config",
          markupBps: 1000,
          fixedMarkupCents: 0,
          minMarkupCents: null,
          maxMarkupCents: null,
        },
        insurancePool: {
          id: 8,
          source: "config",
          feeBps: 200,
          minFeeCents: null,
          maxFeeCents: null,
        },
      },
      totals: {
        baseRateCents: 1000,
        markupCents: 100,
        insurancePoolCents: 22,
        dunnageCents: 0,
        totalShippingCents: 1122,
      },
    },
    createdAt: new Date("2026-07-26T11:00:00.000Z"),
    ...overrides,
  };
}
