import { createHash } from "node:crypto";
import type {
  DropshipEbayFulfillmentCapability,
  DropshipEbayFulfillmentServiceCapability,
} from "../domain/ebay-fulfillment-policy-compatibility";
import { DropshipError } from "../domain/errors";

const CAPABILITY_CACHE_TTL_MS = 5 * 60 * 1000;

export interface DropshipEbayInternalFulfillmentEvidence {
  omsChannelId: number;
  originWarehouseId: number;
  requiredHandlingTimeBusinessDays: number;
  rateBookId: number;
  rateBookCode: string;
  rateTableId: number;
  serviceLevelId: number;
  offeredDestinations: Array<{
    country: string;
    region: string | null;
  }>;
}

export interface DropshipEbayInternalFulfillmentEvidenceRepository {
  loadForStoreConnection(input: {
    storeConnectionId: number;
    evaluatedAt: Date;
  }): Promise<DropshipEbayInternalFulfillmentEvidence>;
}

export interface DropshipCarrierServiceCapability {
  provider: string;
  carrierCode: string;
  serviceCode: string;
  serviceName: string;
  domestic: boolean;
}

export interface DropshipCarrierServiceCapabilitySnapshot {
  serviceLevelId: number;
  routingRevision: number;
  services: DropshipCarrierServiceCapability[];
}

export interface DropshipCarrierServiceCapabilityProvider {
  listServices(input: {
    serviceLevelId: number;
  }): Promise<DropshipCarrierServiceCapabilitySnapshot>;
}

export interface DropshipEbayFulfillmentCapabilityProvider {
  getForStoreConnection(input: {
    storeConnectionId: number;
    marketplaceId: string;
    fresh?: boolean;
  }): Promise<DropshipEbayFulfillmentCapability>;
}

interface Clock {
  now(): Date;
}

interface CacheEntry {
  expiresAtMs: number;
  capability: DropshipEbayFulfillmentCapability;
}

interface EbayServiceMapping {
  provider: string;
  providerCarrierCodes: readonly string[];
  providerServiceCode: string;
  carrier: string;
  ebayServiceCode: string;
}

/**
 * Only mappings with an exact, provider-documented eBay service code belong
 * here. Provider identity is part of the key so a future adapter cannot reuse
 * a coincidentally matching service code. Ambiguous aliases fail closed rather
 * than silently making a promise Card Shellz may not be able to perform.
 */
export const DROPSHIP_EBAY_SERVICE_MAPPINGS: readonly EbayServiceMapping[] = [
  {
    provider: "shipstation_v2",
    providerCarrierCodes: ["usps", "stamps_com"],
    providerServiceCode: "usps_ground_advantage",
    carrier: "USPS",
    // EBAY_US GeteBayDetails (2026-09-04, detail version 1024) identifies
    // USPSParcel as Ground Advantage. USPSGround is explicitly not sellable.
    ebayServiceCode: "USPSParcel",
  },
  {
    provider: "shipstation_v2",
    providerCarrierCodes: ["fedex"],
    providerServiceCode: "fedex_ground",
    carrier: "FedEx",
    ebayServiceCode: "FedExGround",
  },
  {
    provider: "shipstation_v2",
    providerCarrierCodes: ["fedex"],
    providerServiceCode: "fedex_home_delivery",
    carrier: "FedEx",
    ebayServiceCode: "FedExHomeDelivery",
  },
  {
    provider: "shipstation_v2",
    providerCarrierCodes: ["fedex"],
    providerServiceCode: "fedex_2day",
    carrier: "FedEx",
    ebayServiceCode: "FedEx2Day",
  },
  {
    provider: "shipstation_v2",
    providerCarrierCodes: ["fedex"],
    providerServiceCode: "fedex_express_saver",
    carrier: "FedEx",
    ebayServiceCode: "FedExExpressSaver",
  },
  {
    provider: "shipstation_v2",
    providerCarrierCodes: ["fedex"],
    providerServiceCode: "fedex_standard_overnight",
    carrier: "FedEx",
    ebayServiceCode: "FedExStandardOvernight",
  },
  {
    provider: "shipstation_v2",
    providerCarrierCodes: ["ups", "ups_walleted"],
    providerServiceCode: "ups_ground",
    carrier: "UPS",
    ebayServiceCode: "UPSGround",
  },
  {
    provider: "shipstation_v2",
    providerCarrierCodes: ["ups", "ups_walleted"],
    providerServiceCode: "ups_3_day_select",
    carrier: "UPS",
    ebayServiceCode: "UPS3rdDay",
  },
  {
    provider: "shipstation_v2",
    providerCarrierCodes: ["ups", "ups_walleted"],
    providerServiceCode: "ups_next_day_air",
    carrier: "UPS",
    ebayServiceCode: "UPSNextDayAir",
  },
] as const;

export const DROPSHIP_EBAY_US_DESTINATION_REGIONS = [
  "AA", "AE", "AK", "AL", "AP", "AR", "AS", "AZ", "CA", "CO", "CT",
  "DC", "DE", "FL", "GA", "GU", "HI", "IA", "ID", "IL", "IN", "KS",
  "KY", "LA", "MA", "MD", "ME", "MI", "MN", "MO", "MP", "MS", "MT",
  "NC", "ND", "NE", "NH", "NJ", "NM", "NV", "NY", "OH", "OK", "OR",
  "PA", "PR", "RI", "SC", "SD", "TN", "TX", "UT", "VA", "VI", "VT",
  "WA", "WI", "WV", "WY",
] as const;

export class DropshipEbayFulfillmentCapabilityService
implements DropshipEbayFulfillmentCapabilityProvider {
  private readonly cache = new Map<number, CacheEntry>();
  private readonly inFlight = new Map<number, Promise<DropshipEbayFulfillmentCapability>>();

  constructor(private readonly deps: {
    evidence: DropshipEbayInternalFulfillmentEvidenceRepository;
    carrierServices: DropshipCarrierServiceCapabilityProvider;
    clock?: Clock;
    cacheTtlMs?: number;
  }) {}

  async getForStoreConnection(input: {
    storeConnectionId: number;
    marketplaceId: string;
    fresh?: boolean;
  }): Promise<DropshipEbayFulfillmentCapability> {
    const storeConnectionId = positiveInteger(input.storeConnectionId, "storeConnectionId");
    const marketplaceId = requiredString(input.marketplaceId, "marketplaceId");
    if (marketplaceId !== "EBAY_US") {
      throw new DropshipError(
        "DROPSHIP_EBAY_FULFILLMENT_MARKETPLACE_UNSUPPORTED",
        "Card Shellz fulfillment capability validation currently supports EBAY_US only.",
        { storeConnectionId, marketplaceId, retryable: false },
      );
    }
    const now = (this.deps.clock ?? systemClock).now();
    const cached = this.cache.get(storeConnectionId);
    if (!input.fresh && cached && cached.expiresAtMs > now.getTime()) {
      return cloneCapability(cached.capability);
    }
    const existing = this.inFlight.get(storeConnectionId);
    if (!input.fresh && existing) {
      return cloneCapability(await existing);
    }

    const pending = this.loadCapability({ storeConnectionId, marketplaceId, evaluatedAt: now });
    this.inFlight.set(storeConnectionId, pending);
    try {
      const capability = await pending;
      this.cache.set(storeConnectionId, {
        capability,
        expiresAtMs: now.getTime() + (this.deps.cacheTtlMs ?? CAPABILITY_CACHE_TTL_MS),
      });
      return cloneCapability(capability);
    } finally {
      if (this.inFlight.get(storeConnectionId) === pending) {
        this.inFlight.delete(storeConnectionId);
      }
    }
  }

  private async loadCapability(input: {
    storeConnectionId: number;
    marketplaceId: string;
    evaluatedAt: Date;
  }): Promise<DropshipEbayFulfillmentCapability> {
    const evidence = await this.deps.evidence.loadForStoreConnection({
      storeConnectionId: input.storeConnectionId,
      evaluatedAt: input.evaluatedAt,
    });
    const routed = await this.deps.carrierServices.listServices({
      serviceLevelId: evidence.serviceLevelId,
    });
    if (routed.serviceLevelId !== evidence.serviceLevelId) {
      throw new DropshipError(
        "DROPSHIP_EBAY_FULFILLMENT_ROUTING_MISMATCH",
        "Fulfillment routing returned a different service level than the active dropship rate table.",
        {
          expectedServiceLevelId: evidence.serviceLevelId,
          returnedServiceLevelId: routed.serviceLevelId,
          retryable: false,
        },
      );
    }
    const supportedServices = mapRoutedServicesToEbay(routed.services);
    if (supportedServices.length === 0) {
      throw new DropshipError(
        "DROPSHIP_EBAY_FULFILLMENT_SERVICES_REQUIRED",
        "No allowed fulfillment routing method has a verified eBay service mapping.",
        {
          storeConnectionId: input.storeConnectionId,
          serviceLevelId: evidence.serviceLevelId,
          retryable: false,
        },
      );
    }
    const destinationRegions = uniqueSorted(
      evidence.offeredDestinations
        .filter((destination) => destination.country === "US")
        .map((destination) => destination.region)
        .filter((region): region is string => Boolean(region)),
    );
    const destinationCoverageComplete = DROPSHIP_EBAY_US_DESTINATION_REGIONS.every(
      (region) => destinationRegions.includes(region),
    ) || evidence.offeredDestinations.some(
      (destination) => destination.country === "US" && destination.region === null,
    );
    const canonical = {
      marketplaceId: input.marketplaceId,
      requiredHandlingTimeBusinessDays: evidence.requiredHandlingTimeBusinessDays,
      destinationCountry: "US" as const,
      destinationRegions,
      destinationCoverageComplete,
      supportedServices,
      source: {
        omsChannelId: evidence.omsChannelId,
        originWarehouseId: evidence.originWarehouseId,
        rateBookId: evidence.rateBookId,
        rateBookCode: evidence.rateBookCode,
        rateTableId: evidence.rateTableId,
        serviceLevelId: evidence.serviceLevelId,
        fulfillmentRoutingRevision: routed.routingRevision,
      },
    };
    return {
      ...canonical,
      evidenceHash: hashJson(canonical),
    };
  }
}

export function mapRoutedServicesToEbay(
  routedServices: readonly DropshipCarrierServiceCapability[],
): DropshipEbayFulfillmentServiceCapability[] {
  const mapped = routedServices.flatMap((service) => {
    if (!service.domestic) return [];
    const mapping = DROPSHIP_EBAY_SERVICE_MAPPINGS.find((candidate) => (
      candidate.provider === service.provider
      && candidate.providerCarrierCodes.includes(service.carrierCode.toLowerCase())
      && candidate.providerServiceCode === service.serviceCode
    ));
    if (!mapping) return [];
    return [{
      carrier: mapping.carrier,
      ebayServiceCode: mapping.ebayServiceCode,
      serviceName: service.serviceName,
      shipStationCarrierCode: service.carrierCode,
      shipStationServiceCode: service.serviceCode,
    }];
  }).sort((left, right) => (
    left.ebayServiceCode.localeCompare(right.ebayServiceCode)
    || left.shipStationCarrierCode.localeCompare(right.shipStationCarrierCode)
    || left.shipStationServiceCode.localeCompare(right.shipStationServiceCode)
    || left.serviceName.localeCompare(right.serviceName)
  ));
  const uniqueByEbayServiceCode = new Map<string, DropshipEbayFulfillmentServiceCapability>();
  for (const service of mapped) {
    if (!uniqueByEbayServiceCode.has(service.ebayServiceCode)) {
      uniqueByEbayServiceCode.set(service.ebayServiceCode, service);
    }
  }
  return [...uniqueByEbayServiceCode.values()]
    .sort((left, right) => (
      left.carrier.localeCompare(right.carrier)
      || left.serviceName.localeCompare(right.serviceName)
      || left.ebayServiceCode.localeCompare(right.ebayServiceCode)
    ));
}

const systemClock: Clock = { now: () => new Date() };

function cloneCapability(
  capability: DropshipEbayFulfillmentCapability,
): DropshipEbayFulfillmentCapability {
  return {
    ...capability,
    destinationRegions: [...capability.destinationRegions],
    supportedServices: capability.supportedServices.map((service) => ({ ...service })),
    source: { ...capability.source },
  };
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new DropshipError(
      "DROPSHIP_EBAY_FULFILLMENT_CAPABILITY_INVALID_INPUT",
      "eBay fulfillment capability input is invalid.",
      { field, value, retryable: false },
    );
  }
  return value;
}

function requiredString(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new DropshipError(
      "DROPSHIP_EBAY_FULFILLMENT_CAPABILITY_INVALID_INPUT",
      "eBay fulfillment capability input is invalid.",
      { field, retryable: false },
    );
  }
  return normalized;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toUpperCase()).filter(Boolean))]
    .sort();
}

function hashJson(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(sortJsonValue(value)))
    .digest("hex");
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((sorted, key) => {
      sorted[key] = sortJsonValue((value as Record<string, unknown>)[key]);
      return sorted;
    }, {});
}
