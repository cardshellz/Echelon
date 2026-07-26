import type {
  ShipmentLineInput,
  ShipmentParcelPlan,
} from "../../shipping-engine/domain/shipment";
import {
  resolveRuntimeChannelShipping,
  type RuntimeChannelShippingResolution,
} from "../../shipping-engine/application/channel-shipping-policy-runtime.service";
import {
  quoteShipment,
  type ShipmentQuoteRequest,
  type ShipmentQuoteResult,
} from "../../shipping-engine/application/shipment-quote.service";
import type {
  ShipmentParcelProvider,
} from "../../shipping-engine/application/shipment-parcel-provider";
import {
  localRateTableShippingRateProvider,
  type ShippingRateProvider,
} from "../../shipping-engine/application/shipping-rate-provider";
import {
  loadCatalogShippingFactsByVariantIds,
  type CatalogShippingFactByVariant,
} from "../../shipping-engine/infrastructure/catalog-weight.repository";
import {
  PostgresChannelShippingPolicyRuntimeStore,
} from "../../shipping-engine/infrastructure/channel-shipping-policy-runtime.repository";
import type {
  DropshipSharedShippingQuoteProvider,
  DropshipSharedShippingQuoteResult,
  DropshipShippingShadowQuoteRequest,
} from "../application/dropship-shipping-shadow-comparison";

const DROPSHIP_VENDOR_RATE_CONTEXT = {
  pricingChannel: "dropship",
  purpose: "vendor_fulfillment_charge",
} as const;
const DROPSHIP_OMS_CHANNEL_PROVIDER = "manual";
const DROPSHIP_LAUNCH_SERVICE_LEVEL_CODE = "standard";

interface SharedEngineDropshipShippingDependencies {
  loadCatalogFacts: typeof loadCatalogShippingFactsByVariantIds;
  resolveChannelShipping(input: {
    originWarehouseId: number;
    destination: DropshipShippingShadowQuoteRequest["destination"];
  }): Promise<RuntimeChannelShippingResolution>;
  quoteShipment(
    request: ShipmentQuoteRequest,
    dependencies: {
      parcelProvider: ShipmentParcelProvider;
      rateProvider: ShippingRateProvider;
    },
  ): Promise<ShipmentQuoteResult>;
  rateProvider: ShippingRateProvider;
}

export class SharedEngineDropshipShippingQuoteProvider
implements DropshipSharedShippingQuoteProvider {
  constructor(
    private readonly deps: SharedEngineDropshipShippingDependencies,
  ) {}

  async quote(
    input: DropshipShippingShadowQuoteRequest,
  ): Promise<DropshipSharedShippingQuoteResult> {
    const routing = await this.deps.resolveChannelShipping({
      originWarehouseId: input.warehouseId,
      destination: input.destination,
    });
    if (!routing.ok) {
      return unavailable(
        routing.code,
        routing.message,
        [],
        routingSummary(routing),
      );
    }
    if (routing.decision.mode !== "engine_quoted") {
      return unavailable(
        "DROPSHIP_SHARED_SHIPPING_ROUTE_NOT_ENGINE_QUOTED",
        `Dropship vendor shipping route resolved to ${routing.decision.mode}.`,
        [],
        routingSummary(routing),
      );
    }
    if (
      routing.decision.source === "channel_policy"
      && routing.decision.rateBookId === null
    ) {
      return unavailable(
        "DROPSHIP_SHARED_SHIPPING_RATE_BOOK_REQUIRED",
        "The active dropship vendor shipping route has no pricing program.",
        [],
        routingSummary(routing),
      );
    }

    const variantIds = input.items.map((item) => item.productVariantId);
    const factsByVariantId = await this.deps.loadCatalogFacts(variantIds);
    const factWarnings = missingCatalogFactWarnings(
      input.items,
      factsByVariantId,
    );
    const lines = buildShipmentLines(input, factsByVariantId);
    const parcelPlan = buildCartonSnapshotParcelPlan(
      input,
      factsByVariantId,
    );
    const shipmentQuote = await this.deps.quoteShipment({
      channel: "dropship",
      rateBookId:
        routing.decision.source === "channel_policy"
          ? routing.decision.rateBookId ?? undefined
          : undefined,
      originWarehouseId: input.warehouseId,
      destination: input.destination,
      lines,
      quotedAt: input.quotedAt,
    }, {
      parcelProvider: fixedParcelProvider(parcelPlan),
      rateProvider: this.deps.rateProvider,
    });
    if (!shipmentQuote.ok) {
      return unavailable(
        shipmentQuote.code,
        shipmentQuote.errors.join("; "),
        factWarnings,
        routingSummary(routing),
      );
    }

    const warnings = [
      ...factWarnings,
      ...shipmentQuote.parcelPlan.warnings,
      ...shipmentQuote.rates.warnings,
    ];
    const standardRate = shipmentQuote.rates.quotes.find(
      (rate) => rate.serviceLevelCode === DROPSHIP_LAUNCH_SERVICE_LEVEL_CODE,
    );
    if (!standardRate || !shipmentQuote.rates.rateBook) {
      return unavailable(
        "DROPSHIP_SHARED_SHIPPING_STANDARD_RATE_UNAVAILABLE",
        "The shared shipping engine returned no active Standard Shipping rate.",
        warnings,
        routingSummary(routing),
      );
    }

    return {
      status: "quoted",
      baseRateCents: standardRate.totalCents,
      currency: standardRate.currency,
      serviceLevelCode: standardRate.serviceLevelCode,
      rateBookId: shipmentQuote.rates.rateBook.id,
      rateBookCode: shipmentQuote.rates.rateBook.code,
      rateTableId: standardRate.rateTableId,
      resolvedZone: shipmentQuote.rates.zone,
      ratedWeightGrams: shipmentQuote.parcelPlan.parcels.reduce(
        (sum, parcel) => sum + parcel.billableWeightGrams,
        0,
      ),
      warnings,
      routing: routingSummary(routing),
    };
  }
}

export function createSharedEngineDropshipShippingQuoteProviderFromEnv():
SharedEngineDropshipShippingQuoteProvider {
  const policyStore = new PostgresChannelShippingPolicyRuntimeStore();
  return new SharedEngineDropshipShippingQuoteProvider({
    loadCatalogFacts: loadCatalogShippingFactsByVariantIds,
    resolveChannelShipping: (input) =>
      resolveRuntimeChannelShipping(policyStore, {
        provider: DROPSHIP_OMS_CHANNEL_PROVIDER,
        configuredChannelId: process.env.DROPSHIP_OMS_CHANNEL_ID,
        purpose: DROPSHIP_VENDOR_RATE_CONTEXT.purpose,
        originWarehouseId: input.originWarehouseId,
        destination: input.destination,
        legacyFallback: {
          purpose: DROPSHIP_VENDOR_RATE_CONTEXT.purpose,
          mode: "engine_quoted",
          eligibilityMode: "engine",
          rateContext: DROPSHIP_VENDOR_RATE_CONTEXT,
        },
      }),
    quoteShipment,
    rateProvider: localRateTableShippingRateProvider,
  });
}

function buildShipmentLines(
  input: DropshipShippingShadowQuoteRequest,
  factsByVariantId: ReadonlyMap<number, CatalogShippingFactByVariant>,
): ShipmentLineInput[] {
  return input.items.map((item) => {
    const fact = factsByVariantId.get(item.productVariantId);
    const hasWeight = fact?.weightGrams !== null
      && fact?.weightGrams !== undefined
      && fact.weightGrams > 0;
    return {
      sku: fact?.sku ?? null,
      productVariantId: item.productVariantId,
      quantity: item.quantity,
      unitWeightGrams: hasWeight ? fact.weightGrams : null,
      weightSource: hasWeight ? "echelon_catalog" : "missing",
      shippingGroupCode: fact?.shippingGroupCode ?? null,
      shipsInOwnContainer: fact?.shipsInOwnContainer ?? false,
    };
  });
}

function buildCartonSnapshotParcelPlan(
  input: DropshipShippingShadowQuoteRequest,
  factsByVariantId: ReadonlyMap<number, CatalogShippingFactByVariant>,
): ShipmentParcelPlan {
  return {
    provider: {
      name: input.cartonizationProvider.name,
      version: input.cartonizationProvider.version,
    },
    strategy: "dropship_legacy_quote_cartons",
    parcels: input.packages.map((carton) => ({
      sequence: carton.packageSequence,
      source: "cartonization",
      actualWeightGrams: carton.weightGrams,
      billableWeightGrams: carton.weightGrams,
      dimensions: {
        lengthMm: carton.lengthMm,
        widthMm: carton.widthMm,
        heightMm: carton.heightMm,
      },
      shippingGroupCode: resolvePackageShippingGroup(
        carton.items,
        factsByVariantId,
      ),
    })),
    warnings: [],
  };
}

function fixedParcelProvider(
  parcelPlan: ShipmentParcelPlan,
): ShipmentParcelProvider {
  return {
    provider: parcelPlan.provider,
    async plan() {
      return { ok: true, plan: parcelPlan };
    },
  };
}

function resolvePackageShippingGroup(
  items: DropshipShippingShadowQuoteRequest["packages"][number]["items"],
  factsByVariantId: ReadonlyMap<number, CatalogShippingFactByVariant>,
): string | null {
  const groups = new Set(
    items.map((item) =>
      factsByVariantId.get(item.productVariantId)?.shippingGroupCode ?? null),
  );
  return groups.size === 1 ? [...groups][0] ?? null : null;
}

function missingCatalogFactWarnings(
  items: DropshipShippingShadowQuoteRequest["items"],
  factsByVariantId: ReadonlyMap<number, CatalogShippingFactByVariant>,
): string[] {
  return items.flatMap((item) => {
    const fact = factsByVariantId.get(item.productVariantId);
    if (!fact) {
      return [
        `variant ${item.productVariantId}: canonical catalog shipping facts are missing`,
      ];
    }
    if (fact.weightGrams === null || fact.weightGrams <= 0) {
      return [
        `variant ${item.productVariantId}: canonical catalog weight is missing`,
      ];
    }
    return [];
  });
}

function unavailable(
  code: string,
  message: string,
  warnings: string[],
  routing: Record<string, unknown> | null,
): Extract<DropshipSharedShippingQuoteResult, { status: "unavailable" }> {
  return {
    status: "unavailable",
    code,
    message,
    warnings,
    routing,
  };
}

function routingSummary(
  routing: RuntimeChannelShippingResolution,
): Record<string, unknown> {
  return {
    ok: routing.ok,
    channelId: routing.channel?.id ?? null,
    ...(routing.ok
      ? {
          source: routing.decision.source,
          policyId: routing.decision.policyId,
          policyVersion: routing.decision.policyVersion,
          routeId: routing.decision.routeId,
          mode: routing.decision.mode,
          eligibilityMode: routing.decision.eligibilityMode,
          rateBookId: routing.decision.rateBookId,
        }
      : {
          code: routing.code,
          message: routing.message,
        }),
  };
}
