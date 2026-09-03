import type { Pool, PoolClient, QueryResult } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FulfillmentRoutingDropshipCarrierServiceCapabilityProvider,
  PgDropshipEbayInternalFulfillmentEvidenceRepository,
} from "../../infrastructure/dropship-ebay-fulfillment-capability.provider";
import {
  FulfillmentRoutingError,
} from "../../../shipping-engine/application/fulfillment-routing.service";

describe("PgDropshipEbayInternalFulfillmentEvidenceRepository", () => {
  beforeEach(() => {
    delete process.env.DROPSHIP_OMS_CHANNEL_ID;
  });

  it("loads one repeatable-read snapshot from the canonical OMS and dropship rate program", async () => {
    const client = new FakePgClient([
      rows([]),
      rows([{ config: { orderProcessing: { defaultWarehouseId: 1 } } }]),
      rows([{ id: 103, name: "Dropship OMS", status: "active", type: "internal", provider: "manual" }]),
      rows([{ sla_days: 1 }]),
      rows([{
        assignment_id: 34,
        rate_book_id: 34,
        rate_book_code: "dropship-vendor-default",
        zone_set_id: 1,
        origin_warehouse_id: null,
      }]),
      rows([{ rate_table_id: 5, service_level_id: 7 }]),
      rows([
        { destination_country: "US", destination_region: "CA" },
        { destination_country: "US", destination_region: "NY" },
      ]),
      rows([]),
    ]);
    const repository = new PgDropshipEbayInternalFulfillmentEvidenceRepository(
      fakePool(client),
    );

    await expect(repository.loadForStoreConnection({
      storeConnectionId: 44,
      evaluatedAt: new Date("2026-09-01T12:00:00.000Z"),
    })).resolves.toEqual({
      omsChannelId: 103,
      originWarehouseId: 1,
      requiredHandlingTimeBusinessDays: 1,
      rateBookId: 34,
      rateBookCode: "dropship-vendor-default",
      rateTableId: 5,
      serviceLevelId: 7,
      offeredDestinations: [
        { country: "US", region: "CA" },
        { country: "US", region: "NY" },
      ],
    });
    expect(client.queries[0]?.text).toBe(
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    expect(client.queries.at(-1)?.text).toBe("COMMIT");
    expect(client.released).toBe(true);
    expect(client.queries.some((query) => (
      query.text.includes("pricing_channel = $1")
      && query.values?.[0] === "dropship"
      && query.values?.[1] === "vendor_fulfillment_charge"
    ))).toBe(true);
  });

  it("rolls back and fails closed when the OMS SLA is not explicit", async () => {
    const client = new FakePgClient([
      rows([]),
      rows([{ config: { orderProcessing: { defaultWarehouseId: 1 } } }]),
      rows([{ id: 103, name: "Dropship OMS", status: "active", type: "internal", provider: "manual" }]),
      rows([{ sla_days: null }]),
      rows([]),
    ]);
    const repository = new PgDropshipEbayInternalFulfillmentEvidenceRepository(
      fakePool(client),
    );

    await expect(repository.loadForStoreConnection({
      storeConnectionId: 44,
      evaluatedAt: new Date("2026-09-01T12:00:00.000Z"),
    })).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_FULFILLMENT_SLA_REQUIRED",
      context: { omsChannelId: 103, slaDays: null, retryable: false },
    });
    expect(client.queries.at(-1)?.text).toBe("ROLLBACK");
    expect(client.released).toBe(true);
  });
});

describe("FulfillmentRoutingDropshipCarrierServiceCapabilityProvider", () => {
  it("returns only the domestic methods allowed by the service-level routing profile", async () => {
    const resolve = vi.fn(async () => ({
      ok: true as const,
      serviceLevelId: 7,
      profileRevision: 4,
      scope: "domestic" as const,
      candidates: [
        routeMethod({
          providerAccountId: "se-usps",
          providerAccountName: "USPS account",
          carrierCode: "usps",
          carrierName: "USPS",
          serviceCode: "usps_ground_advantage",
          serviceName: "USPS Ground Advantage",
          priority: 1,
        }),
        routeMethod({
          providerAccountId: "se-ups",
          providerAccountName: "UPS account",
          carrierCode: "ups",
          carrierName: "UPS",
          serviceCode: "ups_ground",
          serviceName: "UPS Ground",
          priority: 2,
        }),
      ],
    }));

    await expect(new FulfillmentRoutingDropshipCarrierServiceCapabilityProvider({ resolve })
      .listServices({ serviceLevelId: 7 })).resolves.toEqual({
      serviceLevelId: 7,
      routingRevision: 4,
      services: [
        {
          provider: "shipstation_v2",
          carrierCode: "usps",
          serviceCode: "usps_ground_advantage",
          serviceName: "USPS Ground Advantage",
          domestic: true,
        },
        {
          provider: "shipstation_v2",
          carrierCode: "ups",
          serviceCode: "ups_ground",
          serviceName: "UPS Ground",
          domestic: true,
        },
      ],
    });
    expect(resolve).toHaveBeenCalledWith({
      serviceLevelId: 7,
      scope: "domestic",
    });
  });

  it("fails closed when the service-level routing profile has no domestic methods", async () => {
    const resolve = vi.fn(async () => ({
      ok: false as const,
      serviceLevelId: 7,
      profileRevision: 0,
      scope: "domestic" as const,
      code: "SHIPPING_FULFILLMENT_ROUTING_PROFILE_NOT_CONFIGURED" as const,
      message: "No fulfillment methods are configured for this service level.",
    }));

    await expect(new FulfillmentRoutingDropshipCarrierServiceCapabilityProvider({ resolve })
      .listServices({ serviceLevelId: 7 })).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_FULFILLMENT_ROUTING_REQUIRED",
      context: {
        serviceLevelId: 7,
        routingCode: "SHIPPING_FULFILLMENT_ROUTING_PROFILE_NOT_CONFIGURED",
        routingRevision: 0,
        retryable: false,
      },
    });
  });

  it("classifies routing data errors as non-retryable without leaking details", async () => {
    const resolve = vi.fn(async () => {
      throw new FulfillmentRoutingError(
        500,
        "SHIPPING_FULFILLMENT_ROUTING_DATA_INTEGRITY_ERROR",
        "Fulfillment routing data is inconsistent.",
        ["sensitive database detail"],
      );
    });

    await expect(new FulfillmentRoutingDropshipCarrierServiceCapabilityProvider({ resolve })
      .listServices({ serviceLevelId: 7 })).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE",
      message: "Card Shellz fulfillment routing could not be verified.",
      context: {
        serviceLevelId: 7,
        routingCode: "SHIPPING_FULFILLMENT_ROUTING_DATA_INTEGRITY_ERROR",
        retryable: false,
      },
    });
  });
});

function routeMethod(overrides: {
  providerAccountId: string;
  providerAccountName: string;
  carrierCode: string;
  carrierName: string;
  serviceCode: string;
  serviceName: string;
  priority: number;
}) {
  return {
    providerConnectionId: 11,
    providerConnectionName: "ShipStation",
    provider: "shipstation_v2",
    domestic: true,
    international: false,
    capabilities: null,
    ...overrides,
  };
}

class FakePgClient {
  queries: Array<{ text: string; values?: unknown[] }> = [];
  released = false;

  constructor(private readonly responses: QueryResult[]) {}

  async query(text: string, values?: unknown[]): Promise<QueryResult> {
    this.queries.push({ text, values });
    const response = this.responses.shift();
    if (!response) throw new Error(`No fake response for ${text}`);
    return response;
  }

  release(): void {
    this.released = true;
  }
}

function fakePool(client: FakePgClient): Pool {
  return {
    connect: async () => client as unknown as PoolClient,
  } as unknown as Pool;
}

function rows<T extends Record<string, unknown>>(data: T[]): QueryResult<T> {
  return {
    command: "SELECT",
    rowCount: data.length,
    oid: 0,
    fields: [],
    rows: data,
  };
}
