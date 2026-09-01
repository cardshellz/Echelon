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
  carrierCode: string;
  serviceCode: string;
  serviceName: string;
  domestic: boolean;
}

export interface DropshipCarrierServiceCapabilityProvider {
  listServices(): Promise<DropshipCarrierServiceCapability[]>;
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
  shipStationCarrierCodes: readonly string[];
  shipStationServiceCode: string;
  carrier: string;
  ebayServiceCode: string;
}

/**
 * Only mappings with an exact, provider-documented eBay service code belong
 * here. Ambiguous ShipStation aliases fail closed instead of silently making a
 * fulfillment promise Card Shellz may not be able to perform.
 */
export const DROPSHIP_EBAY_SERVICE_MAPPINGS: readonly EbayServiceMapping[] = [
  {
    shipStationCarrierCodes: ["usps", "stamps_com"],
    shipStationServiceCode: "usps_ground_advantage",
    carrier: "USPS",
    ebayServiceCode: "USPSGround",
  },
  {
    shipStationCarrierCodes: ["fedex"],
    shipStationServiceCode: "fedex_ground",
    carrier: "FedEx",
    ebayServiceCode: "FedExGround",
  },
  {
    shipStationCarrierCodes: ["fedex"],
    shipStationServiceCode: "fedex_home_delivery",
    carrier: "FedEx",
    ebayServiceCode: "FedExHomeDelivery",
  },
  {
    shipStationCarrierCodes: ["fedex"],
    shipStationServiceCode: "fedex_2day",
    carrier: "FedEx",
    ebayServiceCode: "FedEx2Day",
  },
  {
    shipStationCarrierCodes: ["fedex"],
    shipStationServiceCode: "fedex_express_saver",
    carrier: "FedEx",
    ebayServiceCode: "FedExExpressSaver",
  },
  {
    shipStationCarrierCodes: ["fedex"],
    shipStationServiceCode: "fedex_standard_overnight",
    carrier: "FedEx",
    ebayServiceCode: "FedExStandardOvernight",
  },
  {
    shipStationCarrierCodes: ["ups", "ups_walleted"],
    shipStationServiceCode: "ups_ground",
    carrier: "UPS",
    ebayServiceCode: "UPSGround",
  },
  {
    shipStationCarrierCodes: ["ups", "ups_walleted"],
    shipStationServiceCode: "ups_3_day_select",
    carrier: "UPS",
    ebayServiceCode: "UPS3rdDay",
  },
  {
    shipStationCarrierCodes: ["ups", "ups_walleted"],
    shipStationServiceCode: "ups_next_day_air",
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
    const [evidence, connectedServices] = await Promise.all([
      this.deps.evidence.loadForStoreConnection({
        storeConnectionId: input.storeConnectionId,
        evaluatedAt: input.evaluatedAt,
      }),
      this.deps.carrierServices.listServices(),
    ]);
    const supportedServices = mapConnectedServicesToEbay(connectedServices);
    if (supportedServices.length === 0) {
      throw new DropshipError(
        "DROPSHIP_EBAY_FULFILLMENT_SERVICES_REQUIRED",
        "No connected ShipStation carrier service has a verified eBay fulfillment mapping.",
        { storeConnectionId: input.storeConnectionId, retryable: false },
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
      },
    };
    return {
      ...canonical,
      evidenceHash: hashJson(canonical),
    };
  }
}

export function mapConnectedServicesToEbay(
  connectedServices: readonly DropshipCarrierServiceCapability[],
): DropshipEbayFulfillmentServiceCapability[] {
  const mapped = connectedServices.flatMap((service) => {
    if (!service.domestic) return [];
    const mapping = DROPSHIP_EBAY_SERVICE_MAPPINGS.find((candidate) => (
      candidate.shipStationCarrierCodes.includes(service.carrierCode.toLowerCase())
      && candidate.shipStationServiceCode === service.serviceCode
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
