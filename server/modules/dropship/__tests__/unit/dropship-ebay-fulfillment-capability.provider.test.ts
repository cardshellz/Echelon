import type { Pool, PoolClient, QueryResult } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PgDropshipEbayInternalFulfillmentEvidenceRepository,
  ShipStationDropshipCarrierServiceCapabilityProvider,
} from "../../infrastructure/dropship-ebay-fulfillment-capability.provider";
import type {
  ShipStationV2RatingAdapter,
} from "../../../shipping-engine/infrastructure/shipstation-v2-rating.adapter";

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
      rows([{ rate_table_id: 5 }]),
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

describe("ShipStationDropshipCarrierServiceCapabilityProvider", () => {
  it("returns the services enabled on every connected carrier", async () => {
    const adapter: ShipStationV2RatingAdapter = {
      isConfigured: () => true,
      getRates: vi.fn(),
      listCarriers: async () => ({
        configured: true,
        carriers: [
          { carrierId: "se-usps", code: "usps", name: "USPS" },
          { carrierId: "se-ups", code: "ups", name: "UPS" },
        ],
      }),
      listCarrierServices: async (carrier) => ({
        configured: true,
        services: [{
          carrierId: carrier.carrierId,
          carrierCode: carrier.code,
          serviceCode: `${carrier.code}_ground`,
          serviceName: `${carrier.name} Ground`,
          domestic: true,
          international: false,
        }],
      }),
    };

    await expect(new ShipStationDropshipCarrierServiceCapabilityProvider(adapter)
      .listServices()).resolves.toEqual([
      {
        carrierCode: "usps",
        serviceCode: "usps_ground",
        serviceName: "USPS Ground",
        domestic: true,
      },
      {
        carrierCode: "ups",
        serviceCode: "ups_ground",
        serviceName: "UPS Ground",
        domestic: true,
      },
    ]);
  });
});

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
