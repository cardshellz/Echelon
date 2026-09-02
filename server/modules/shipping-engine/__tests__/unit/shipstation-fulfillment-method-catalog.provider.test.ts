import { describe, expect, it, vi } from "vitest";
import { ShipStationV2Error, type ShipStationV2RatingAdapter } from "../../infrastructure/shipstation-v2-rating.adapter";
import { ShipStationFulfillmentMethodCatalogProvider } from "../../infrastructure/shipstation-fulfillment-method-catalog.provider";

describe("ShipStationFulfillmentMethodCatalogProvider", () => {
  it("returns an explicit not-configured state without attempting service calls", async () => {
    const adapter = fakeAdapter();
    adapter.listCarriers.mockResolvedValue({ configured: false, carriers: [] });

    await expect(provider(adapter).loadCatalog(connection())).resolves.toMatchObject({
      status: "not_configured",
      code: "SHIPPING_FULFILLMENT_ROUTING_SHIPSTATION_NOT_CONFIGURED",
      methods: [],
    });
    expect(adapter.listCarrierServices).not.toHaveBeenCalled();
  });

  it("keeps exact carrier-account identity and sorts a deterministic catalog", async () => {
    const adapter = fakeAdapter();
    adapter.listCarriers.mockResolvedValue({
      configured: true,
      carriers: [
        { carrierId: "se-usps", code: "stamps_com", name: "Warehouse USPS" },
        { carrierId: "se-fedex", code: "fedex", name: "Warehouse FedEx" },
      ],
    });
    adapter.listCarrierServices.mockImplementation(async (carrier) => ({
      configured: true as const,
      services: [{
        carrierId: carrier.carrierId,
        carrierCode: carrier.code,
        serviceCode: carrier.code === "fedex" ? "fedex_ground" : "usps_ground_advantage",
        serviceName: carrier.code === "fedex" ? "FedEx Ground" : "USPS Ground Advantage",
        domestic: true,
        international: false,
      }],
    }));

    const result = await provider(adapter).loadCatalog(connection());

    expect(result).toMatchObject({
      status: "available",
    });
    if (result.status !== "available") throw new Error("Expected available catalog.");
    expect(result.methods.map((method) => ({
      providerConnectionId: method.providerConnectionId,
      providerConnectionName: method.providerConnectionName,
      providerAccountId: method.providerAccountId,
      providerAccountName: method.providerAccountName,
      carrierName: method.carrierName,
      serviceCode: method.serviceCode,
    }))).toEqual([
      {
        providerConnectionId: 11,
        providerConnectionName: "Primary ShipStation",
        providerAccountId: "se-fedex",
        providerAccountName: "Warehouse FedEx",
        carrierName: "FedEx",
        serviceCode: "fedex_ground",
      },
      {
        providerConnectionId: 11,
        providerConnectionName: "Primary ShipStation",
        providerAccountId: "se-usps",
        providerAccountName: "Warehouse USPS",
        carrierName: "USPS",
        serviceCode: "usps_ground_advantage",
      },
    ]);
  });

  it("returns a retryable unavailable state for classified ShipStation failures", async () => {
    const adapter = fakeAdapter();
    adapter.listCarriers.mockRejectedValue(new ShipStationV2Error(
      "SHIPSTATION_V2_HTTP_ERROR",
      "provider failed",
      { status: 503 },
    ));

    await expect(provider(adapter).loadCatalog(connection())).resolves.toMatchObject({
      status: "unavailable",
      code: "SHIPPING_FULFILLMENT_ROUTING_SHIPSTATION_UNAVAILABLE",
      retryable: true,
      methods: [],
    });
  });

  it("classifies rejected credentials as non-retryable and actionable", async () => {
    const adapter = fakeAdapter();
    adapter.listCarriers.mockRejectedValue(new ShipStationV2Error(
      "SHIPSTATION_V2_HTTP_ERROR",
      "provider failed",
      { status: 401 },
    ));

    await expect(provider(adapter).loadCatalog(connection())).resolves.toMatchObject({
      status: "unavailable",
      code: "SHIPPING_FULFILLMENT_ROUTING_SHIPSTATION_CREDENTIAL_REJECTED",
      retryable: false,
      methods: [],
    });
  });

  it("identifies fields that conflict in a duplicate provider method", async () => {
    const adapter = fakeAdapter();
    adapter.listCarriers.mockResolvedValue({
      configured: true,
      carriers: [
        { carrierId: "se-ups", code: "ups", name: "UPS account A" },
        { carrierId: "se-ups", code: "ups", name: "UPS account B" },
      ],
    });
    adapter.listCarrierServices.mockImplementation(async (carrier) => ({
      configured: true as const,
      services: [{
        carrierId: carrier.carrierId,
        carrierCode: carrier.code,
        serviceCode: "ups_ground",
        serviceName: "UPS Ground",
        domestic: true,
        international: false,
      }],
    }));

    await expect(provider(adapter).loadCatalog(connection())).resolves.toMatchObject({
      status: "unavailable",
      code: "SHIPPING_FULFILLMENT_ROUTING_PROVIDER_INVALID_RESPONSE",
      message: expect.stringContaining("providerAccountName"),
      retryable: false,
    });
  });

  it("constructs the ShipStation client from the selected connection credential", async () => {
    const adapter = fakeAdapter();
    adapter.listCarriers.mockResolvedValue({ configured: true, carriers: [] });
    const adapterFactory = vi.fn().mockReturnValue(adapter);
    const catalogProvider = new ShipStationFulfillmentMethodCatalogProvider({ adapterFactory });

    await catalogProvider.loadCatalog({
      connectionId: 22,
      connectionName: "Secondary ShipStation",
      credential: "connection-specific-key",
    });

    expect(adapterFactory).toHaveBeenCalledWith("connection-specific-key");
  });
});

function provider(adapter: ShipStationV2RatingAdapter) {
  return new ShipStationFulfillmentMethodCatalogProvider({
    adapter,
  });
}

function connection() {
  return { connectionId: 11, connectionName: "Primary ShipStation", credential: "secret" };
}

function fakeAdapter() {
  return {
    isConfigured: vi.fn().mockReturnValue(true),
    getRates: vi.fn(),
    listCarriers: vi.fn(),
    listCarrierServices: vi.fn(),
  } as unknown as ShipStationV2RatingAdapter & {
    listCarriers: ReturnType<typeof vi.fn>;
    listCarrierServices: ReturnType<typeof vi.fn>;
  };
}
