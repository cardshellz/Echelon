import { afterEach, describe, expect, it, vi } from "vitest";

async function loadModule() {
  process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
  process.env.SHIPSTATION_API_KEY ||= "key";
  process.env.SHIPSTATION_API_SECRET ||= "secret";
  return await import("../enrich-shipstation-physical-shipment-ids");
}

describe("enrich-shipstation-physical-shipment-ids", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses flags with dry-run and bounded defaults", async () => {
    const { parseFlags } = await loadModule();

    expect(parseFlags([])).toMatchObject({
      help: false,
      mode: "dry-run",
      limit: 25,
      concurrency: 1,
      delayMs: 250,
      requestTimeoutMs: 20000,
      progressEvery: 25,
      orderNumber: null,
      wmsShipmentId: null,
      json: false,
    });

    expect(parseFlags([
      "--execute",
      "--limit=all",
      "--concurrency=4",
      "--delay-ms=0",
      "--request-timeout-ms=1234",
      "--progress-every=10",
      "--order-number=#59453",
      "--wms-shipment-id=4313",
      "--json",
    ])).toMatchObject({
      mode: "execute",
      limit: null,
      concurrency: 4,
      delayMs: 0,
      requestTimeoutMs: 1234,
      progressEvery: 10,
      orderNumber: "#59453",
      wmsShipmentId: 4313,
      json: true,
    });
  });

  it("rejects unsafe or malformed flags", async () => {
    const { parseFlags } = await loadModule();

    expect(() => parseFlags(["--dry-run", "--execute"])).toThrow(/Cannot pass both/);
    expect(() => parseFlags(["--limit=0"])).toThrow(/positive integer or all/);
    expect(() => parseFlags(["--concurrency=0"])).toThrow(/positive integer no greater than 8/);
    expect(() => parseFlags(["--concurrency=9"])).toThrow(/positive integer no greater than 8/);
    expect(() => parseFlags(["--delay-ms=-1"])).toThrow(/non-negative integer/);
    expect(() => parseFlags(["--request-timeout-ms=0"])).toThrow(/positive integer/);
    expect(() => parseFlags(["--progress-every=-1"])).toThrow(/non-negative integer/);
    expect(() => parseFlags(["--order-number="])).toThrow(/cannot be blank/);
    expect(() => parseFlags(["--wms-shipment-id=abc"])).toThrow(/positive integer/);
    expect(() => parseFlags(["--bogus"])).toThrow(/Unknown flag/);
  });

  it("uses the same ShipStation physical identity format as the webhook resolver", async () => {
    const { shipStationShipmentExternalFulfillmentId } = await loadModule();

    expect(shipStationShipmentExternalFulfillmentId(435425332)).toBe("shipstation_shipment:435425332");
    expect(shipStationShipmentExternalFulfillmentId(0)).toBeNull();
    expect(shipStationShipmentExternalFulfillmentId(1.5)).toBeNull();
  });

  it("classifies PostgreSQL unique conflicts for parallel idempotency races", async () => {
    const { isPostgresUniqueViolation } = await loadModule();

    expect(isPostgresUniqueViolation({ code: "23505" })).toBe(true);
    expect(isPostgresUniqueViolation({ code: "23503" })).toBe(false);
    expect(isPostgresUniqueViolation(new Error("duplicate key"))).toBe(false);
  });

  it("aborts stalled ShipStation HTTP requests with a bounded error", async () => {
    const { fetchShipStationJsonWithTimeout } = await loadModule();

    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error("missing abort signal"));
        return;
      }

      signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      }, { once: true });
    })));

    await expect(fetchShipStationJsonWithTimeout(
      "https://ssapi.shipstation.com/shipments",
      "Basic test",
      1,
    )).rejects.toThrow(/timed out after 1ms/);
  });

  it("builds ShipStation shipment paths with includeShipmentItems=true", async () => {
    const { buildShipStationShipmentsPath, buildShipStationShipmentsUrl } = await loadModule();

    expect(buildShipStationShipmentsPath({ orderId: 755010744 }))
      .toBe("/shipments?orderId=755010744&includeShipmentItems=true");
    expect(buildShipStationShipmentsPath({ orderNumber: "#59381" }))
      .toBe("/shipments?orderNumber=%2359381&includeShipmentItems=true");
    expect(buildShipStationShipmentsUrl("https://ssapi.shipstation.com/", { orderId: 1 }))
      .toBe("https://ssapi.shipstation.com/shipments?orderId=1&includeShipmentItems=true");
  });

  it("de-dupes ShipStation lookups by physical shipment id", async () => {
    const { mergeShipStationShipments } = await loadModule();

    const merged = mergeShipStationShipments([
      { shipmentId: 100, trackingNumber: "A" },
      { shipmentId: 100, trackingNumber: "A" },
      { shipmentId: 101, trackingNumber: "B" },
    ]);

    expect(merged).toHaveLength(2);
    expect(merged.map((shipment: any) => shipment.shipmentId)).toEqual([100, 101]);
  });

  it("matches only exact one-to-one tracking numbers", async () => {
    const { decideShipStationPhysicalMatch } = await loadModule();

    expect(decideShipStationPhysicalMatch(
      { tracking_number: " 1ZABC " },
      [{ shipmentId: 10, trackingNumber: "1zabc", orderId: 99 }],
    )).toMatchObject({
      kind: "match",
      externalFulfillmentId: "shipstation_shipment:10",
    });

    expect(decideShipStationPhysicalMatch(
      { tracking_number: "1ZABC" },
      [{ shipmentId: 10, trackingNumber: "OTHER" }],
    )).toMatchObject({
      kind: "no_match",
    });

    expect(decideShipStationPhysicalMatch(
      { tracking_number: "1ZABC" },
      [
        { shipmentId: 10, trackingNumber: "1ZABC" },
        { shipmentId: 11, trackingNumber: "1ZABC" },
      ],
    )).toMatchObject({
      kind: "ambiguous",
      matchingShipmentIds: [10, 11],
    });

    expect(decideShipStationPhysicalMatch(
      { tracking_number: "1ZABC" },
      [{ shipmentId: null, trackingNumber: "1ZABC" }],
    )).toMatchObject({
      kind: "invalid_candidate",
    });
  });

  it("queries real WMS shipment columns and casts enum status comparisons to text", async () => {
    const { buildCandidateSql } = await loadModule();
    const query = buildCandidateSql({
      limit: 50,
      orderNumber: "#59453",
      wmsShipmentId: 4313,
    });

    expect(query.sql).toContain("FROM wms.outbound_shipments s");
    expect(query.sql).toContain("JOIN wms.orders o ON o.id = s.order_id");
    expect(query.sql).toContain("s.status::text = 'shipped'");
    expect(query.sql).not.toContain("s.status = 'shipped'");
    expect(query.sql).toContain("s.shipstation_order_id IS NOT NULL");
    expect(query.sql).toContain("external_fulfillment_id");
    expect(query.params).toEqual(["#59453", 4313]);
  });
});
