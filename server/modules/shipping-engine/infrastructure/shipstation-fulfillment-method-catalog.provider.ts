import type {
  ShippingFulfillmentCatalogMethod,
} from "@shared/types/shipping-fulfillment-routing";
import { shippingFulfillmentMethodIdentityKey } from "@shared/lib/shipping-fulfillment-method-identity";
import type {
  FulfillmentProviderAdapter,
  FulfillmentProviderConnectionCatalog,
} from "../application/connected-fulfillment-method-catalog.service";
import {
  createShipStationV2RatingAdapter,
  mapV2CarrierCode,
  ShipStationV2Error,
  type ShipStationV2RatingAdapter,
  type V2Carrier,
  type V2CarrierService,
} from "./shipstation-v2-rating.adapter";

const MAX_CONNECTED_CARRIERS = 100;
const MAX_CATALOG_METHODS = 5_000;
const SERVICE_FETCH_CONCURRENCY = 5;

class CatalogValidationError extends Error {
  constructor(readonly details: string[]) {
    super("ShipStation returned an invalid fulfillment method catalog.");
    this.name = "CatalogValidationError";
  }
}

export class ShipStationFulfillmentMethodCatalogProvider
implements FulfillmentProviderAdapter {
  readonly descriptor = {
    provider: "shipstation_v2",
    displayName: "ShipStation",
    credentialLabel: "ShipStation V2 API key",
    supportsManagedConnections: true,
  } as const;

  constructor(private readonly deps: {
    adapter?: ShipStationV2RatingAdapter;
    adapterFactory?: (credential: string) => ShipStationV2RatingAdapter;
  } = {}) {}

  verifyCredential(credential: string): Promise<FulfillmentProviderConnectionCatalog> {
    return this.loadCatalog({
      connectionId: 1,
      connectionName: "ShipStation credential verification",
      credential,
    });
  }

  async loadCatalog(input: {
    connectionId: number;
    connectionName: string;
    credential: string;
  }): Promise<FulfillmentProviderConnectionCatalog> {
    const adapter = this.deps.adapter
      ?? this.deps.adapterFactory?.(input.credential)
      ?? createShipStationV2RatingAdapter({ apiKey: input.credential });
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

      const methods = normalizeCatalog(input, serviceResults.flatMap(({ carrier, result }) => (
        result.configured
          ? result.services.map((service) => ({ carrier, service }))
          : []
      )));
      if (methods.length > MAX_CATALOG_METHODS) {
        throw new CatalogValidationError([
          `methodCount exceeds ${MAX_CATALOG_METHODS}`,
        ]);
      }
      return {
        status: "available",
        methods,
      };
    } catch (error) {
      if (error instanceof ShipStationV2Error) {
        const status = typeof error.context.status === "number" ? error.context.status : null;
        if (status === 401 || status === 403) {
          return unavailableCatalog(
            "unavailable",
            "SHIPPING_FULFILLMENT_ROUTING_SHIPSTATION_CREDENTIAL_REJECTED",
            "ShipStation rejected this connection credential. Replace the API key before retrying.",
            false,
          );
        }
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

function normalizeCatalog(
  connection: { connectionId: number; connectionName: string },
  entries: Array<{
  carrier: V2Carrier;
  service: V2CarrierService;
  }>,
): ShippingFulfillmentCatalogMethod[] {
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
    const domestic = service.domestic === true;
    const international = service.international === true;
    if (!domestic && !international) {
      throw new CatalogValidationError([
        `Method ${providerAccountId} / ${service.serviceCode} has no destination scope.`,
      ]);
    }
    const method: ShippingFulfillmentCatalogMethod = {
      providerConnectionId: connection.connectionId,
      providerConnectionName: boundedString(connection.connectionName, 160, "connectionName"),
      provider: "shipstation_v2",
      providerAccountId,
      providerAccountName: boundedString(carrier.name, 160, "carrierName"),
      carrierCode,
      carrierName: boundedString(mapV2CarrierCode(carrierCode), 160, "canonicalCarrierName"),
      serviceCode: boundedString(service.serviceCode, 80, "serviceCode"),
      serviceName: boundedString(service.serviceName, 160, "serviceName"),
      domestic,
      international,
      capabilities: {
        supportsMultiPackage: service.supportsMultiPackage === true,
        supportsReturns: service.supportsReturns === true,
        supportsPrepaidDutiesTaxes: service.supportsPrepaidDutiesTaxes === true,
        sendRates: service.sendRates === true,
        displaySchemes: boundedStringList(service.displaySchemes, 20, 80, "displaySchemes"),
      },
    };
    const key = shippingFulfillmentMethodIdentityKey(method);
    const existing = byIdentity.get(key);
    if (existing && JSON.stringify(existing) !== JSON.stringify(method)) {
      const fields = conflictingMethodFields(existing, method);
      throw new CatalogValidationError([
        `Conflicting duplicate method ${providerAccountId} / ${method.serviceCode}; differing fields: ${fields.join(", ")}.`,
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
    || Number(right.domestic) - Number(left.domestic)
    || Number(right.international) - Number(left.international)
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

function boundedStringList(
  value: readonly string[],
  maxItems: number,
  maxItemLength: number,
  field: string,
): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new CatalogValidationError([`${field} must contain at most ${maxItems} values.`]);
  }
  const normalized = value.map((entry, index) => (
    boundedString(entry, maxItemLength, `${field}.${index}`)
  ));
  if (new Set(normalized).size !== normalized.length) {
    throw new CatalogValidationError([`${field} contains duplicate values.`]);
  }
  return normalized;
}

function unavailableCatalog(
  status: "not_configured" | "unavailable",
  code: string,
  message: string,
  retryable: boolean,
): FulfillmentProviderConnectionCatalog {
  return {
    status,
    code,
    message,
    retryable,
    methods: [],
  };
}

function conflictingMethodFields(
  left: ShippingFulfillmentCatalogMethod,
  right: ShippingFulfillmentCatalogMethod,
): string[] {
  const fields: Array<keyof ShippingFulfillmentCatalogMethod> = [
    "providerConnectionId",
    "providerConnectionName",
    "provider",
    "providerAccountId",
    "providerAccountName",
    "carrierCode",
    "carrierName",
    "serviceCode",
    "serviceName",
    "domestic",
    "international",
  ];
  const conflicts = fields.filter((field) => left[field] !== right[field]);
  if (JSON.stringify(left.capabilities) !== JSON.stringify(right.capabilities)) {
    conflicts.push("capabilities");
  }
  return conflicts;
}
