import { z } from "zod";
import type {
  ShippingQuoteEvidenceWriter,
} from "../../shipping-engine/application/shipping-quote-evidence-writer";
import {
  calculateBasisPointsFeeCents,
} from "../domain/shipping-quote";
import type { DropshipLogger } from "./dropship-ports";
import type {
  DropshipSharedShippingQuoteProvider,
  DropshipSharedShippingQuoteRequest,
  DropshipSharedShippingQuoteResult,
} from "./dropship-shared-shipping-quote";
export type {
  DropshipSharedShippingQuoteProvider,
  DropshipSharedShippingQuoteRequest,
  DropshipSharedShippingQuoteResult,
} from "./dropship-shared-shipping-quote";
import type {
  DropshipShippingQuoteSnapshotRecord,
} from "./dropship-shipping-quote-service";
import {
  shouldShadowDropshipShippingQuote,
  type DropshipShippingShadowRolloutPolicy,
} from "./dropship-shipping-shadow-rollout";

const nonNegativeSafeIntegerSchema = z.number().int().nonnegative().refine(
  Number.isSafeInteger,
);
const positiveSafeIntegerSchema = z.number().int().positive().refine(
  Number.isSafeInteger,
);

const quoteItemSchema = z.object({
  productVariantId: positiveSafeIntegerSchema,
  quantity: positiveSafeIntegerSchema,
}).strict();

const cartonSchema = z.object({
  packageSequence: positiveSafeIntegerSchema,
  items: z.array(quoteItemSchema).min(1),
  boxId: positiveSafeIntegerSchema,
  boxCode: z.string().trim().min(1),
  weightGrams: positiveSafeIntegerSchema,
  dimensionsMm: z.object({
    length: positiveSafeIntegerSchema,
    width: positiveSafeIntegerSchema,
    height: positiveSafeIntegerSchema,
  }).strict(),
}).passthrough();

const legacyQuotePayloadSchema = z.object({
  version: z.literal(2),
  destination: z.object({
    country: z.string().trim().length(2),
    region: z.string().trim().length(2).nullable(),
    postalCode: z.string().trim().min(1),
  }).strict(),
  items: z.array(quoteItemSchema).min(1),
  packages: z.array(cartonSchema).min(1),
  providers: z.object({
    cartonization: z.object({
      name: z.string().trim().min(1),
      version: z.string().trim().min(1),
    }).passthrough(),
  }).passthrough(),
  policies: z.object({
    shippingMarkup: z.object({
      markupBps: nonNegativeSafeIntegerSchema,
      fixedMarkupCents: nonNegativeSafeIntegerSchema,
      minMarkupCents: nonNegativeSafeIntegerSchema.nullable(),
      maxMarkupCents: nonNegativeSafeIntegerSchema.nullable(),
    }).passthrough(),
    insurancePool: z.object({
      feeBps: nonNegativeSafeIntegerSchema,
      minFeeCents: nonNegativeSafeIntegerSchema.nullable(),
      maxFeeCents: nonNegativeSafeIntegerSchema.nullable(),
    }).passthrough(),
  }).strict(),
}).passthrough();

export interface DropshipShippingShadowQuoteRequest
extends DropshipSharedShippingQuoteRequest {
  legacyQuoteSnapshotId: number;
}

type DropshipSharedShippingComparisonEvidence =
  | DropshipSharedShippingQuoteResult
  | (
      Extract<DropshipSharedShippingQuoteResult, { status: "quoted" }>
      & {
        projectedVendorCharge: {
          baseRateCents: number;
          markupCents: number;
          insurancePoolCents: number;
          dunnageCents: number;
          totalShippingCents: number;
        };
      }
    );

export interface DropshipShippingShadowComparator {
  compare(snapshot: DropshipShippingQuoteSnapshotRecord): Promise<void>;
}

export interface DropshipShippingShadowComparisonDependencies {
  rolloutPolicy: DropshipShippingShadowRolloutPolicy;
  sharedQuoteProvider: DropshipSharedShippingQuoteProvider;
  evidenceWriter: ShippingQuoteEvidenceWriter;
  logger: DropshipLogger;
  clock: { now(): Date };
}

export class DropshipShippingShadowComparisonService
implements DropshipShippingShadowComparator {
  constructor(
    private readonly deps: DropshipShippingShadowComparisonDependencies,
  ) {}

  async compare(
    snapshot: DropshipShippingQuoteSnapshotRecord,
  ): Promise<void> {
    if (isSharedCutoverQuotePayload(snapshot.quotePayload)) {
      return;
    }
    if (!shouldShadowDropshipShippingQuote(
      this.deps.rolloutPolicy,
      snapshot.storeConnectionId,
    )) {
      return;
    }

    const parsedPayload = legacyQuotePayloadSchema.safeParse(
      snapshot.quotePayload,
    );
    if (!parsedPayload.success) {
      await this.persistComparison(snapshot, {
        outcome: "legacy_snapshot_invalid",
        differences: ["legacy quote payload v2 validation failed"],
        request: null,
        shared: null,
        sharedError: parsedPayload.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
      return;
    }

    if (snapshot.storeConnectionId === null) {
      await this.persistComparison(snapshot, {
        outcome: "legacy_snapshot_invalid",
        differences: ["legacy quote snapshot is missing its store connection ID"],
        request: null,
        shared: null,
        sharedError: {
          path: "storeConnectionId",
          message: "Expected a dropship store connection ID.",
        },
      });
      return;
    }

    const payload = parsedPayload.data;
    const request = buildSharedQuoteRequest(snapshot, payload);
    let shared: DropshipSharedShippingQuoteResult;
    try {
      shared = await this.deps.sharedQuoteProvider.quote(request);
    } catch (error) {
      await this.persistComparison(snapshot, {
        outcome: "shared_error",
        differences: ["shared shipping engine threw before returning a quote"],
        request,
        shared: null,
        sharedError: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
      return;
    }

    if (shared.status === "unavailable") {
      await this.persistComparison(snapshot, {
        outcome: "shared_unavailable",
        differences: [`${shared.code}: ${shared.message}`],
        request,
        shared,
        sharedError: null,
      });
      return;
    }

    const projected = projectSharedVendorCharge(snapshot, payload, shared);
    const differences: string[] = [];
    if (snapshot.currency.toUpperCase() !== shared.currency.toUpperCase()) {
      differences.push(
        `currency ${snapshot.currency.toUpperCase()} != ${shared.currency.toUpperCase()}`,
      );
    }
    if (snapshot.baseRateCents !== shared.baseRateCents) {
      differences.push(
        `base rate ${snapshot.baseRateCents} != ${shared.baseRateCents}`,
      );
    }
    if (snapshot.totalShippingCents !== projected.totalShippingCents) {
      differences.push(
        `vendor charge ${snapshot.totalShippingCents} != ${projected.totalShippingCents}`,
      );
    }

    await this.persistComparison(snapshot, {
      outcome: differences.length === 0 ? "match" : "amount_mismatch",
      differences,
      request,
      shared: {
        ...shared,
        projectedVendorCharge: projected,
      },
      sharedError: null,
    });
  }

  private async persistComparison(
    snapshot: DropshipShippingQuoteSnapshotRecord,
    comparison: {
      outcome:
        | "match"
        | "amount_mismatch"
        | "shared_unavailable"
        | "shared_error"
        | "legacy_snapshot_invalid";
      differences: string[];
      request: DropshipShippingShadowQuoteRequest | null;
      shared: DropshipSharedShippingComparisonEvidence | null;
      sharedError: unknown;
    },
  ): Promise<void> {
    const observedAt = this.deps.clock.now();
    const write = await this.deps.evidenceWriter.persistOnce({
      source: "shadow",
      evidenceKind: "dropship_shipping_rate_comparison",
      evidenceKey: String(snapshot.quoteSnapshotId),
      destinationCountry: snapshot.destinationCountry,
      destinationPostalCode: snapshot.destinationPostalCode,
      resolvedZone:
        comparison.shared?.status === "quoted"
          ? comparison.shared.resolvedZone
          : null,
      requestHash: snapshot.requestHash,
      requestPayload: {
        kind: "dropship_shipping_rate_comparison",
        legacyQuoteSnapshotId: snapshot.quoteSnapshotId,
        vendorId: snapshot.vendorId,
        storeConnectionId: snapshot.storeConnectionId,
        warehouseId: snapshot.warehouseId,
        destination: comparison.request?.destination ?? {
          country: snapshot.destinationCountry,
          region: null,
          postalCode: snapshot.destinationPostalCode,
        },
        items: comparison.request?.items ?? [],
      },
      packing: comparison.request === null ? null : {
        cartonizationProvider: comparison.request.cartonizationProvider,
        packages: comparison.request.packages,
      },
      rates: {
        legacy: {
          baseRateCents: snapshot.baseRateCents,
          markupCents: snapshot.markupCents,
          insurancePoolCents: snapshot.insurancePoolCents,
          dunnageCents: snapshot.dunnageCents,
          totalShippingCents: snapshot.totalShippingCents,
          currency: snapshot.currency,
          rateTableId: snapshot.rateTableId,
        },
        shared: comparison.shared,
      },
      metadata: {
        outcome: comparison.outcome,
        differences: comparison.differences,
        sharedError: comparison.sharedError,
        observedAt: observedAt.toISOString(),
      },
      createdAt: observedAt,
    });

    this.deps.logger.info({
      code: "DROPSHIP_SHIPPING_SHADOW_COMPARISON_RECORDED",
      message: "Dropship legacy and shared shipping rates were compared.",
      context: {
        legacyQuoteSnapshotId: snapshot.quoteSnapshotId,
        shadowSnapshotId: write.snapshotId,
        evidenceCreated: write.created,
        outcome: comparison.outcome,
        differenceCount: comparison.differences.length,
      },
    });
  }
}

function isSharedCutoverQuotePayload(
  payload: Record<string, unknown>,
): boolean {
  if (payload.version !== 3) return false;
  const pricing = payload.pricing;
  return Boolean(
    pricing
    && typeof pricing === "object"
    && (pricing as { source?: unknown }).source === "shared_engine",
  );
}

function buildSharedQuoteRequest(
  snapshot: DropshipShippingQuoteSnapshotRecord,
  payload: z.infer<typeof legacyQuotePayloadSchema>,
): DropshipShippingShadowQuoteRequest {
  if (snapshot.storeConnectionId === null) {
    throw new Error(
      "Dropship shipping quote snapshot is missing its store connection ID.",
    );
  }
  return {
    legacyQuoteSnapshotId: snapshot.quoteSnapshotId,
    vendorId: snapshot.vendorId,
    storeConnectionId: snapshot.storeConnectionId,
    warehouseId: snapshot.warehouseId,
    destination: payload.destination,
    items: payload.items,
    packages: payload.packages.map((carton) => ({
      packageSequence: carton.packageSequence,
      items: carton.items,
      boxId: carton.boxId,
      boxCode: carton.boxCode,
      weightGrams: carton.weightGrams,
      lengthMm: carton.dimensionsMm.length,
      widthMm: carton.dimensionsMm.width,
      heightMm: carton.dimensionsMm.height,
    })),
    cartonizationProvider: payload.providers.cartonization,
    quotedAt: snapshot.createdAt,
  };
}

function projectSharedVendorCharge(
  snapshot: DropshipShippingQuoteSnapshotRecord,
  payload: z.infer<typeof legacyQuotePayloadSchema>,
  shared: Extract<DropshipSharedShippingQuoteResult, { status: "quoted" }>,
): {
  baseRateCents: number;
  markupCents: number;
  insurancePoolCents: number;
  dunnageCents: number;
  totalShippingCents: number;
} {
  const markupCents = calculateBasisPointsFeeCents(shared.baseRateCents, {
    bps: payload.policies.shippingMarkup.markupBps,
    fixedCents: payload.policies.shippingMarkup.fixedMarkupCents,
    minCents: payload.policies.shippingMarkup.minMarkupCents,
    maxCents: payload.policies.shippingMarkup.maxMarkupCents,
  });
  const dunnageCents = snapshot.dunnageCents;
  const insurancePoolCents = calculateBasisPointsFeeCents(
    shared.baseRateCents + markupCents + dunnageCents,
    {
      bps: payload.policies.insurancePool.feeBps,
      minCents: payload.policies.insurancePool.minFeeCents,
      maxCents: payload.policies.insurancePool.maxFeeCents,
    },
  );
  return {
    baseRateCents: shared.baseRateCents,
    markupCents,
    insurancePoolCents,
    dunnageCents,
    totalShippingCents:
      shared.baseRateCents + markupCents + dunnageCents + insurancePoolCents,
  };
}
