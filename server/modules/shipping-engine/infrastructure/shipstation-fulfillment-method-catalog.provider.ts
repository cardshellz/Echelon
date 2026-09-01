import { createHash } from "node:crypto";
import type {
  ShippingFulfillmentCatalog,
  ShippingFulfillmentCatalogMethod,
} from "@shared/types/shipping-fulfillment-routing";
import type { FulfillmentMethodCatalogProvider } from "../application/fulfillment-routing.service";
import {
  createShipStationV2RatingAdapter,
  mapV2CarrierCode,
  ShipStationV2Error,
  type ShipStationV2RatingAdapter,
  type V2Carrier,
} from "./shipstation-v2-rating.adapter";

const MAX_CONNECTED_CARRIERS = 100;
const MAX_CATALOG_METHODS = 5_000;
const SERVICE_FETCH_CONCURRENCY = 5;

interface Clock {
  now(): Date;
}

class CatalogValidationError extends Error {
  constructor(readonly details: string[]) {
    super("ShipStation returned an invalid fulfillment method catalog.");
    this.name = "CatalogValidationError";
  }
}

export class ShipStationFulfillmentMethodCatalogProvider
implements FulfillmentMethodCatalogProvider {
  constructor(private readonly deps: {
    adapter?: ShipStationV2RatingAdapter;
    clock?: Clock;
  } = {}) {}

  async loadCatalog(): Promise<ShippingFulfillmentCatalog> {
    const adapter = this.deps.adapter ?? createShipStationV2RatingAdapter();
    try {
      const carriersResult = await adapter.listCarriers();
      if (!carriersResult.configured) {
        return unavailableCatalog(
          "not_configured",
          "SHIPPING_FULFILLMENT_ROUTING_SHIPSTATION_NOT_CONFIGURED",
          "ShipStation v2 credentials are required to configure fulfillment routing.",
          false,
        );
      }
      if (carriersResult.carriers.length > MAX_CONNECTED_CARRIERS) {
        throw new CatalogValidationError([
          `carrierCount exceeds ${MAX_CONNECTED_CARRIERS}`,
        ]);
      }

      const serviceResults = await mapWithConcurrency(
        carriersResult.carriers,
        SERVICE_FETCH_CONCURRENCY,
        async (carrier) => ({
          carrier,
          result: await adapter.listCarrierServices(carrier),
        }),
      );
      if (serviceResults.some(({ result }) => !result.configured)) {
        throw new CatalogValidationError([
          "A configured ShipStation carrier returned an unconfigured service catalog.",
        ]);
      }

      const methods = normalizeCatalog(serviceResults.flatMap(({ carrier, result }) => (
        result.configured
          ? result.services.map((service) => ({ carrier, service }))
          : []
      )));
      if (methods.length > MAX_CATALOG_METHODS) {
        throw new CatalogValidationError([
          `methodCount exceeds ${MAX_CATALOG_METHODS}`,
        ]);
      }
      const fetchedAt = cloneDate((this.deps.clock ?? systemClock).now());
      return {
        status: "available",
        provider: "shipstation_v2",
        catalogHash: catalogHash(methods),
        fetchedAt: fetchedAt.toISOString(),
        methods,
      };
    } catch (error) {
      if (error instanceof ShipStationV2Error) {
        return unavailableCatalog(
          "unavailable",
          "SHIPPING_FULFILLMENT_ROUTING_SHIPSTATION_UNAVAILABLE",
          "ShipStation carrier methods could not be loaded. Retry before changing routing.",
          true,
        );
      }
      if (error instanceof CatalogValidationError) {
        return unavailableCatalog(
          "unavailable",
          "SHIPPING_FULFILLMENT_ROUTING_PROVIDER_INVALID_RESPONSE",
          `${error.message} ${error.details.join(" ")}`.trim(),
          false,
        );
      }
      throw error;
    }
  }
}

function normalizeCatalog(entries: Array<{
  carrier: V2Carrier;
  service: {
    carrierId: string;
    carrierCode: string;
    serviceCode: string;
    serviceName: string;
    domestic: boolean;
    international: boolean;
  };
}>): ShippingFulfillmentCatalogMethod[] {
  const byIdentity = new Map<string, ShippingFulfillmentCatalogMethod>();
  for (const { carrier, service } of entries) {
    const providerAccountId = boundedString(carrier.carrierId, 120, "carrierId");
    if (providerAccountId !== boundedString(service.carrierId, 120, "service.carrierId")) {
      throw new CatalogValidationError(["Carrier service account identity did not match its parent carrier."]);
    }
    const carrierCode = boundedString(service.carrierCode, 50, "carrierCode");
    if (carrierCode !== boundedString(carrier.code, 50, "carrier.code")) {
      throw new CatalogValidationError(["Carrier service code did not match its parent carrier."]);
    }
    const method: ShippingFulfillmentCatalogMethod = {
      provider: "shipstation_v2",
      providerAccountId,
      providerAccountName: boundedString(carrier.name, 160, "carrierName"),
      carrierCode,
      carrierName: boundedString(mapV2CarrierCode(carrierCode), 160, "canonicalCarrierName"),
      serviceCode: boundedString(service.serviceCode, 80, "serviceCode"),
      serviceName: boundedString(service.serviceName, 160, "serviceName"),
      domestic: service.domestic === true,
      international: service.international === true,
    };
    const key = methodKey(method);
    const existing = byIdentity.get(key);
    if (existing && JSON.stringify(existing) !== JSON.stringify(method)) {
      throw new CatalogValidationError([
        `Conflicting duplicate method ${providerAccountId} / ${method.serviceCode}.`,
      ]);
    }
    byIdentity.set(key, method);
  }
  return [...byIdentity.values()].sort((left, right) => (
    left.providerAccountName.localeCompare(right.providerAccountName)
    || left.providerAccountId.localeCompare(right.providerAccountId)
    || left.carrierName.localeCompare(right.carrierName)
    || left.serviceName.localeCompare(right.serviceName)
    || left.serviceCode.localeCompare(right.serviceCode)
  ));
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++;
        results[index] = await mapper(values[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function boundedString(value: string, maxLength: number, field: string): string {
  if (typeof value !== "string") throw new CatalogValidationError([`${field} is not a string.`]);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new CatalogValidationError([
      `${field} must contain between 1 and ${maxLength} characters.`,
    ]);
  }
  return normalized;
}

function methodKey(method: ShippingFulfillmentCatalogMethod): string {
  return `${method.provider}\u0000${method.providerAccountId}\u0000${method.serviceCode}`;
}

function catalogHash(methods: readonly ShippingFulfillmentCatalogMethod[]): string {
  return createHash("sha256").update(JSON.stringify(methods)).digest("hex");
}

function unavailableCatalog(
  status: "not_configured" | "unavailable",
  code: string,
  message: string,
  retryable: boolean,
): ShippingFulfillmentCatalog {
  return {
    status,
    provider: "shipstation_v2",
    code,
    message,
    retryable,
    methods: [],
  };
}

function cloneDate(value: Date): Date {
  const cloned = new Date(value.getTime());
  if (Number.isNaN(cloned.getTime())) {
    throw new Error("Fulfillment method catalog clock returned an invalid date.");
  }
  return cloned;
}

const systemClock: Clock = { now: () => new Date() };
