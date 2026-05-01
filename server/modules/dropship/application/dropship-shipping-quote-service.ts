import { createHash } from "crypto";
import {
  DROPSHIP_DEFAULT_INSURANCE_POOL_FEE_BPS,
  type DropshipStoreConnectionStatus,
  type DropshipVendorStatus,
} from "../../../../shared/schema/dropship.schema";
import { DropshipError } from "../domain/errors";
import {
  DROPSHIP_DEFAULT_SHIPPING_CURRENCY,
  DROPSHIP_DEFAULT_SHIPPING_MARKUP_BPS,
  calculateBasisPointsFeeCents,
  normalizeDropshipQuoteItems,
  normalizeDropshipShippingDestination,
  type DropshipCartonizedPackage,
  type NormalizedDropshipShippingDestination,
  type NormalizedDropshipShippingQuoteItem,
} from "../domain/shipping-quote";
import type { DropshipClock, DropshipLogEvent, DropshipLogger } from "./dropship-ports";
import type {
  DropshipVendorProvisioningService,
} from "./dropship-vendor-provisioning-service";
import type { DropshipCartonizationProvider } from "./dropship-cartonization-provider";
import { quoteDropshipShippingForMemberInputSchema } from "./dropship-shipping-dtos";
import type {
  DropshipShippingRateMatch,
  DropshipShippingRateProvider,
  DropshipShippingZoneMatch,
} from "./dropship-shipping-rate-provider";
import {
  quoteDropshipShippingInputSchema,
  type QuoteDropshipShippingInput,
} from "./dropship-use-case-dtos";

export interface DropshipShippingStoreContext {
  vendorId: number;
  vendorStatus: DropshipVendorStatus;
  entitlementStatus: string;
  storeConnectionId: number;
  storeStatus: DropshipStoreConnectionStatus;
  platform: "ebay" | "shopify";
}

export interface DropshipShippingMarkupPolicy {
  id: number | null;
  source: "config" | "default";
  markupBps: number;
  fixedMarkupCents: number;
  minMarkupCents: number | null;
  maxMarkupCents: number | null;
}

export interface DropshipInsurancePoolPolicy {
  id: number | null;
  source: "config" | "default";
  feeBps: number;
  minFeeCents: number | null;
  maxFeeCents: number | null;
}

export interface DropshipShippingQuoteSnapshotRecord {
  quoteSnapshotId: number;
  vendorId: number;
  storeConnectionId: number | null;
  warehouseId: number;
  rateTableId: number | null;
  destinationCountry: string;
  destinationPostalCode: string | null;
  currency: string;
  idempotencyKey: string | null;
  requestHash: string | null;
  packageCount: number;
  baseRateCents: number;
  markupCents: number;
  insurancePoolCents: number;
  dunnageCents: number;
  totalShippingCents: number;
  quotePayload: Record<string, unknown>;
  createdAt: Date;
}

export interface CreateDropshipShippingQuoteSnapshotInput {
  vendorId: number;
  storeConnectionId: number;
  warehouseId: number;
  rateTableId: number | null;
  destination: NormalizedDropshipShippingDestination;
  currency: string;
  idempotencyKey: string;
  requestHash: string;
  packageCount: number;
  baseRateCents: number;
  markupCents: number;
  insurancePoolCents: number;
  dunnageCents: number;
  totalShippingCents: number;
  quotePayload: Record<string, unknown>;
  createdAt: Date;
  actor: {
    actorType: "vendor" | "admin" | "system" | "job";
    actorId?: string;
  };
}

export interface DropshipShippingQuoteRepository {
  findQuoteSnapshotByIdempotencyKey(input: {
    vendorId: number;
    idempotencyKey: string;
  }): Promise<DropshipShippingQuoteSnapshotRecord | null>;
  loadStoreContext(input: {
    vendorId: number;
    storeConnectionId: number;
  }): Promise<DropshipShippingStoreContext | null>;
  getActiveShippingMarkupPolicy(quotedAt: Date): Promise<DropshipShippingMarkupPolicy | null>;
  getActiveInsurancePoolPolicy(quotedAt: Date): Promise<DropshipInsurancePoolPolicy | null>;
  createQuoteSnapshot(
    input: CreateDropshipShippingQuoteSnapshotInput,
  ): Promise<DropshipShippingQuoteSnapshotRecord>;
}

export interface DropshipShippingQuoteServiceDependencies {
  vendorProvisioning: DropshipVendorProvisioningService;
  repository: DropshipShippingQuoteRepository;
  cartonization: DropshipCartonizationProvider;
  rateProvider: DropshipShippingRateProvider;
  clock: DropshipClock;
  logger: DropshipLogger;
}

export interface DropshipShippingQuoteResult {
  quoteSnapshotId: number;
  idempotentReplay: boolean;
  vendorId: number;
  storeConnectionId: number;
  warehouseId: number;
  destination: NormalizedDropshipShippingDestination;
  packageCount: number;
  totalShippingCents: number;
  currency: string;
  carrierServices: Array<{ carrier: string; service: string }>;
  internalBreakdown: {
    baseRateCents: number;
    markupCents: number;
    insurancePoolCents: number;
    dunnageCents: number;
    rateTableId: number | null;
    requestHash: string;
  };
}

export class DropshipShippingQuoteService {
  constructor(private readonly deps: DropshipShippingQuoteServiceDependencies) {}

  async quoteForMember(memberId: string, input: unknown): Promise<DropshipShippingQuoteResult> {
    const parsed = quoteDropshipShippingForMemberInputSchema.parse(input);
    const vendor = (await this.deps.vendorProvisioning.provisionForMember(memberId)).vendor;
    return this.executeQuote({
      ...parsed,
      vendorId: vendor.vendorId,
    }, {
      actorType: "vendor",
      actorId: memberId,
    });
  }

  async quote(input: unknown): Promise<DropshipShippingQuoteResult> {
    return this.executeQuote(quoteDropshipShippingInputSchema.parse(input), {
      actorType: "system",
    });
  }

  private async executeQuote(
    parsed: QuoteDropshipShippingInput,
    actor: CreateDropshipShippingQuoteSnapshotInput["actor"],
  ): Promise<DropshipShippingQuoteResult> {
    const normalizedDestination = normalizeDropshipShippingDestination(parsed.destination);
    const normalizedItems = normalizeDropshipQuoteItems(parsed.items);
    const requestHash = hashDropshipShippingQuoteRequest({
      ...parsed,
      destination: normalizedDestination,
      items: normalizedItems,
    });

    const existingSnapshot = await this.deps.repository.findQuoteSnapshotByIdempotencyKey({
      vendorId: parsed.vendorId,
      idempotencyKey: parsed.idempotencyKey,
    });
    if (existingSnapshot) {
      if (existingSnapshot.requestHash !== requestHash) {
        throw new DropshipError(
          "DROPSHIP_IDEMPOTENCY_CONFLICT",
          "Dropship shipping quote idempotency key was reused with a different request.",
          { vendorId: parsed.vendorId },
        );
      }
      return mapSnapshotToQuoteResult(existingSnapshot, true);
    }

    const quotedAt = this.deps.clock.now();
    await this.assertQuoteContext(parsed);
    const cartonization = await this.deps.cartonization.cartonize({
      vendorId: parsed.vendorId,
      storeConnectionId: parsed.storeConnectionId,
      warehouseId: parsed.warehouseId,
      destination: normalizedDestination,
      items: normalizedItems,
      quotedAt,
    });
    const packages = cartonization.packages;

    const ratedPackages = await this.deps.rateProvider.quoteRates({
      vendorId: parsed.vendorId,
      storeConnectionId: parsed.storeConnectionId,
      warehouseId: parsed.warehouseId,
      destination: normalizedDestination,
      packages,
      quotedAt,
    });
    const { zone, rates: rateMatches } = ratedPackages;
    assertEveryPackageHasRate(packages, rateMatches);

    const currency = assertSingleCurrency(rateMatches);
    const baseRateCents = sumCents(rateMatches.map((rate) => rate.rateCents));
    const [markupPolicy, insurancePolicy] = await Promise.all([
      this.deps.repository.getActiveShippingMarkupPolicy(quotedAt),
      this.deps.repository.getActiveInsurancePoolPolicy(quotedAt),
    ]);
    const resolvedMarkupPolicy = markupPolicy ?? defaultShippingMarkupPolicy();
    const resolvedInsurancePolicy = insurancePolicy ?? defaultInsurancePoolPolicy();
    const markupCents = calculateBasisPointsFeeCents(baseRateCents, {
      bps: resolvedMarkupPolicy.markupBps,
      fixedCents: resolvedMarkupPolicy.fixedMarkupCents,
      minCents: resolvedMarkupPolicy.minMarkupCents,
      maxCents: resolvedMarkupPolicy.maxMarkupCents,
    });
    const dunnageCents = 0;
    const insurancePoolCents = calculateBasisPointsFeeCents(baseRateCents + markupCents + dunnageCents, {
      bps: resolvedInsurancePolicy.feeBps,
      minCents: resolvedInsurancePolicy.minFeeCents,
      maxCents: resolvedInsurancePolicy.maxFeeCents,
    });
    const totalShippingCents = baseRateCents + markupCents + dunnageCents + insurancePoolCents;
    const rateTableId = resolveSnapshotRateTableId(rateMatches);
    const quotePayload = buildQuotePayload({
      destination: normalizedDestination,
      items: normalizedItems,
      packages,
      zone,
      rateMatches,
      cartonizationProvider: cartonization.engine,
      rateProvider: ratedPackages.provider,
      cartonizationWarnings: cartonization.warnings,
      markupPolicy: resolvedMarkupPolicy,
      insurancePolicy: resolvedInsurancePolicy,
      totals: {
        baseRateCents,
        markupCents,
        insurancePoolCents,
        dunnageCents,
        totalShippingCents,
      },
    });

    const snapshot = await this.deps.repository.createQuoteSnapshot({
      vendorId: parsed.vendorId,
      storeConnectionId: parsed.storeConnectionId,
      warehouseId: parsed.warehouseId,
      rateTableId,
      destination: normalizedDestination,
      currency,
      idempotencyKey: parsed.idempotencyKey,
      requestHash,
      packageCount: packages.length,
      baseRateCents,
      markupCents,
      insurancePoolCents,
      dunnageCents,
      totalShippingCents,
      quotePayload,
      createdAt: quotedAt,
      actor,
    });

    this.deps.logger.info({
      code: "DROPSHIP_SHIPPING_QUOTE_CREATED",
      message: "Dropship shipping quote snapshot created.",
      context: {
        vendorId: parsed.vendorId,
        storeConnectionId: parsed.storeConnectionId,
        quoteSnapshotId: snapshot.quoteSnapshotId,
        packageCount: packages.length,
        totalShippingCents,
      },
    });

    return mapSnapshotToQuoteResult(snapshot, false);
  }

  private async assertQuoteContext(input: QuoteDropshipShippingInput): Promise<void> {
    const context = await this.deps.repository.loadStoreContext({
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
    });
    if (!context) {
      throw new DropshipError(
        "DROPSHIP_STORE_CONNECTION_REQUIRED",
        "Dropship store connection is required before quoting shipping.",
        { vendorId: input.vendorId, storeConnectionId: input.storeConnectionId },
      );
    }

    assertVendorCanQuoteShipping(context);
    assertStoreCanQuoteShipping(context);
  }
}

export function hashDropshipShippingQuoteRequest(input: {
  vendorId: number;
  storeConnectionId: number;
  warehouseId: number;
  destination: NormalizedDropshipShippingDestination;
  items: readonly NormalizedDropshipShippingQuoteItem[];
  idempotencyKey: string;
}): string {
  const canonical = {
    vendorId: input.vendorId,
    storeConnectionId: input.storeConnectionId,
    warehouseId: input.warehouseId,
    destination: input.destination,
    items: input.items,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function makeDropshipShippingQuoteLogger(): DropshipLogger {
  return {
    info: (event) => logDropshipShippingQuoteEvent("info", event),
    warn: (event) => logDropshipShippingQuoteEvent("warn", event),
    error: (event) => logDropshipShippingQuoteEvent("error", event),
  };
}

export const systemDropshipShippingQuoteClock: DropshipClock = {
  now: () => new Date(),
};

function assertVendorCanQuoteShipping(context: DropshipShippingStoreContext): void {
  if (["closed", "lapsed", "suspended"].includes(context.vendorStatus)) {
    throw new DropshipError(
      "DROPSHIP_SHIPPING_VENDOR_BLOCKED",
      "Dropship vendor status does not allow shipping quotes.",
      { vendorId: context.vendorId, vendorStatus: context.vendorStatus },
    );
  }
}

function assertStoreCanQuoteShipping(context: DropshipShippingStoreContext): void {
  if (context.storeStatus !== "connected") {
    throw new DropshipError(
      "DROPSHIP_SHIPPING_STORE_BLOCKED",
      "Dropship store connection is not healthy enough to quote shipping.",
      {
        vendorId: context.vendorId,
        storeConnectionId: context.storeConnectionId,
        storeStatus: context.storeStatus,
      },
    );
  }
}

function assertEveryPackageHasRate(
  packages: readonly DropshipCartonizedPackage[],
  rateMatches: readonly DropshipShippingRateMatch[],
): void {
  const ratedSequences = new Set(rateMatches.map((rate) => rate.packageSequence));
  const missingPackage = packages.find((carton) => !ratedSequences.has(carton.packageSequence));
  if (missingPackage) {
    throw new DropshipError(
      "DROPSHIP_SHIPPING_RATE_REQUIRED",
      "Active dropship shipping rate data is required before quoting shipping.",
      { packageSequence: missingPackage.packageSequence },
    );
  }
}

function assertSingleCurrency(rateMatches: readonly DropshipShippingRateMatch[]): string {
  const currencies = new Set(rateMatches.map((rate) => rate.currency));
  if (currencies.size !== 1) {
    throw new DropshipError(
      "DROPSHIP_SHIPPING_RATE_CURRENCY_MISMATCH",
      "Dropship shipping quote cannot combine rates with different currencies.",
      { currencies: [...currencies] },
    );
  }
  return rateMatches[0]?.currency ?? DROPSHIP_DEFAULT_SHIPPING_CURRENCY;
}

function sumCents(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

function defaultShippingMarkupPolicy(): DropshipShippingMarkupPolicy {
  return {
    id: null,
    source: "default",
    markupBps: DROPSHIP_DEFAULT_SHIPPING_MARKUP_BPS,
    fixedMarkupCents: 0,
    minMarkupCents: null,
    maxMarkupCents: null,
  };
}

function defaultInsurancePoolPolicy(): DropshipInsurancePoolPolicy {
  return {
    id: null,
    source: "default",
    feeBps: DROPSHIP_DEFAULT_INSURANCE_POOL_FEE_BPS,
    minFeeCents: null,
    maxFeeCents: null,
  };
}

function resolveSnapshotRateTableId(rateMatches: readonly DropshipShippingRateMatch[]): number | null {
  const uniqueRateTableIds = new Set(rateMatches.map((rate) => rate.rateTableId));
  return uniqueRateTableIds.size === 1 ? rateMatches[0]?.rateTableId ?? null : null;
}

function buildQuotePayload(input: {
  destination: NormalizedDropshipShippingDestination;
  items: readonly NormalizedDropshipShippingQuoteItem[];
  packages: readonly DropshipCartonizedPackage[];
  zone: DropshipShippingZoneMatch;
  rateMatches: readonly DropshipShippingRateMatch[];
  cartonizationProvider: { name: string; version: string };
  rateProvider: { name: string; version: string };
  cartonizationWarnings: readonly string[];
  markupPolicy: DropshipShippingMarkupPolicy;
  insurancePolicy: DropshipInsurancePoolPolicy;
  totals: {
    baseRateCents: number;
    markupCents: number;
    insurancePoolCents: number;
    dunnageCents: number;
    totalShippingCents: number;
  };
}): Record<string, unknown> {
  const ratesByPackage = new Map(input.rateMatches.map((rate) => [rate.packageSequence, rate]));
  return {
    version: 1,
    destination: input.destination,
    items: input.items,
    zone: input.zone,
    providers: {
      cartonization: input.cartonizationProvider,
      rates: input.rateProvider,
    },
    warnings: {
      cartonization: input.cartonizationWarnings,
    },
    packages: input.packages.map((carton) => {
      const rate = ratesByPackage.get(carton.packageSequence);
      return {
        packageSequence: carton.packageSequence,
        productVariantId: carton.productVariantId,
        quantity: carton.quantity,
        boxId: carton.boxId,
        boxCode: carton.boxCode,
        weightGrams: carton.weightGrams,
        dimensionsMm: {
          length: carton.lengthMm,
          width: carton.widthMm,
          height: carton.heightMm,
        },
        rate,
      };
    }),
    policies: {
      shippingMarkup: input.markupPolicy,
      insurancePool: input.insurancePolicy,
    },
    totals: input.totals,
  };
}

function mapSnapshotToQuoteResult(
  snapshot: DropshipShippingQuoteSnapshotRecord,
  idempotentReplay: boolean,
): DropshipShippingQuoteResult {
  const payload = snapshot.quotePayload as {
    destination?: NormalizedDropshipShippingDestination;
    packages?: Array<{ rate?: { carrier: string; service: string } }>;
  };
  const carrierServices = uniqueCarrierServices(
    (payload.packages ?? [])
      .map((carton) => carton.rate)
      .filter((rate): rate is { carrier: string; service: string } => Boolean(rate)),
  );

  return {
    quoteSnapshotId: snapshot.quoteSnapshotId,
    idempotentReplay,
    vendorId: snapshot.vendorId,
    storeConnectionId: snapshot.storeConnectionId ?? 0,
    warehouseId: snapshot.warehouseId,
    destination: payload.destination ?? {
      country: snapshot.destinationCountry,
      region: null,
      postalCode: snapshot.destinationPostalCode ?? "",
    },
    packageCount: snapshot.packageCount,
    totalShippingCents: snapshot.totalShippingCents,
    currency: snapshot.currency,
    carrierServices,
    internalBreakdown: {
      baseRateCents: snapshot.baseRateCents,
      markupCents: snapshot.markupCents,
      insurancePoolCents: snapshot.insurancePoolCents,
      dunnageCents: snapshot.dunnageCents,
      rateTableId: snapshot.rateTableId,
      requestHash: snapshot.requestHash ?? "",
    },
  };
}

function uniqueCarrierServices(
  rates: ReadonlyArray<{ carrier: string; service: string }>,
): Array<{ carrier: string; service: string }> {
  const seen = new Set<string>();
  const result: Array<{ carrier: string; service: string }> = [];
  for (const rate of rates) {
    const key = `${rate.carrier}:${rate.service}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push({ carrier: rate.carrier, service: rate.service });
    }
  }
  return result;
}

function logDropshipShippingQuoteEvent(
  level: "info" | "warn" | "error",
  event: DropshipLogEvent,
): void {
  const payload = JSON.stringify({
    code: event.code,
    message: event.message,
    context: event.context ?? {},
  });
  if (level === "error") {
    console.error(payload);
    return;
  }
  if (level === "warn") {
    console.warn(payload);
    return;
  }
  console.info(payload);
}
