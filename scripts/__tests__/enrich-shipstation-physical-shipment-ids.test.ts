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
      scope: "physical-id",
      limit: 25,
      concurrency: 1,
      delayMs: 250,
      requestTimeoutMs: 20000,
      maxRetries: 3,
      retryBaseDelayMs: 2000,
      maxRateLimitErrors: 25,
      progressEvery: 25,
      orderNumber: null,
      wmsShipmentId: null,
      operator: "script:enrich-shipstation-identity",
      json: false,
    });

    expect(parseFlags([
      "--execute",
      "--scope=provider-order-linkage",
      "--limit=all",
      "--concurrency=4",
      "--delay-ms=0",
      "--request-timeout-ms=1234",
      "--max-retries=5",
      "--retry-base-delay-ms=333",
      "--max-rate-limit-errors=7",
      "--progress-every=10",
      "--order-number=#59453",
      "--wms-shipment-id=4313",
      "--operator=operator@example.com",
      "--json",
    ])).toMatchObject({
      mode: "execute",
      scope: "provider-order-linkage",
      limit: null,
      concurrency: 4,
      delayMs: 0,
      requestTimeoutMs: 1234,
      maxRetries: 5,
      retryBaseDelayMs: 333,
      maxRateLimitErrors: 7,
      progressEvery: 10,
      orderNumber: "#59453",
      wmsShipmentId: 4313,
      operator: "operator@example.com",
      json: true,
    });
  });

  it("rejects unsafe or malformed flags", async () => {
    const { parseFlags } = await loadModule();

    expect(() => parseFlags(["--dry-run", "--execute"])).toThrow(/Cannot pass both/);
    expect(() => parseFlags(["--scope=unknown"])).toThrow(/physical-id or provider-order-linkage/);
    expect(() => parseFlags(["--limit=0"])).toThrow(/positive integer or all/);
    expect(() => parseFlags(["--concurrency=0"])).toThrow(/positive integer no greater than 8/);
    expect(() => parseFlags(["--concurrency=9"])).toThrow(/positive integer no greater than 8/);
    expect(() => parseFlags(["--delay-ms=-1"])).toThrow(/non-negative integer/);
    expect(() => parseFlags(["--request-timeout-ms=0"])).toThrow(/positive integer/);
    expect(() => parseFlags(["--max-retries=-1"])).toThrow(/non-negative integer/);
    expect(() => parseFlags(["--retry-base-delay-ms=-1"])).toThrow(/non-negative integer/);
    expect(() => parseFlags(["--max-rate-limit-errors=-1"])).toThrow(/non-negative integer/);
    expect(() => parseFlags(["--progress-every=-1"])).toThrow(/non-negative integer/);
    expect(() => parseFlags(["--order-number="])).toThrow(/cannot be blank/);
    expect(() => parseFlags(["--wms-shipment-id=abc"])).toThrow(/positive integer/);
    expect(() => parseFlags(["--operator="])).toThrow(/cannot be blank/);
    expect(() => parseFlags([`--operator=${"x".repeat(121)}`])).toThrow(/cannot exceed 120/);
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

  it("parses ShipStation Retry-After seconds and dates", async () => {
    const { parseRetryAfterHeader } = await loadModule();

    expect(parseRetryAfterHeader("3")).toBe(3000);
    expect(parseRetryAfterHeader("Wed, 01 Jul 2026 00:00:03 GMT", Date.parse("2026-07-01T00:00:00Z")))
      .toBe(3000);
    expect(parseRetryAfterHeader("not a date")).toBeNull();
    expect(parseRetryAfterHeader(null)).toBeNull();
  });

  it("surfaces ShipStation 429 responses as typed HTTP errors", async () => {
    const { fetchShipStationJsonWithTimeout, ShipStationHttpError } = await loadModule();

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 429,
      headers: {
        get: (name: string) => name.toLowerCase() === "retry-after" ? "2" : null,
      },
      text: async () => "Too Many Request",
    })));

    await expect(fetchShipStationJsonWithTimeout(
      "https://ssapi.shipstation.com/shipments",
      "Basic test",
      1000,
    )).rejects.toMatchObject({
      name: "ShipStationHttpError",
      status: 429,
      retryAfterMs: 2000,
    });
    await expect(fetchShipStationJsonWithTimeout(
      "https://ssapi.shipstation.com/shipments",
      "Basic test",
      1000,
    )).rejects.toBeInstanceOf(ShipStationHttpError);
  });

  it("opens the run-level rate-limit circuit after total 429 responses", async () => {
    const {
      createShipStationRateLimitCircuit,
      recordShipStationRateLimitResponse,
    } = await loadModule();

    const circuit = createShipStationRateLimitCircuit();
    expect(recordShipStationRateLimitResponse(circuit, 3)).toBeNull();
    expect(recordShipStationRateLimitResponse(circuit, 3)).toBeNull();
    expect(recordShipStationRateLimitResponse(circuit, 3))
      .toBe("stopped after 3 ShipStation 429 responses during this run");
    expect(circuit).toMatchObject({
      rateLimitResponses: 3,
      stoppedEarlyReason: "stopped after 3 ShipStation 429 responses during this run",
    });
    expect(recordShipStationRateLimitResponse(circuit, 3))
      .toBe("stopped after 3 ShipStation 429 responses during this run");
    expect(circuit.rateLimitResponses).toBe(4);
  });

  it("builds ShipStation shipment paths with includeShipmentItems=true", async () => {
    const { buildShipStationShipmentsPath, buildShipStationShipmentsUrl } = await loadModule();

    expect(buildShipStationShipmentsPath({ orderId: 755010744 }))
      .toBe("/shipments?orderId=755010744&includeShipmentItems=true");
    expect(buildShipStationShipmentsPath({ orderNumber: "#59381" }))
      .toBe("/shipments?orderNumber=%2359381&includeShipmentItems=true");
    expect(buildShipStationShipmentsPath({ trackingNumber: " 1ZABC " }))
      .toBe("/shipments?trackingNumber=1ZABC&includeShipmentItems=true");
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

  it("parses only supported persisted ShipStation physical identities", async () => {
    const { parsePersistedShipStationPhysicalShipmentId } = await loadModule();

    expect(parsePersistedShipStationPhysicalShipmentId("shipstation_shipment:419095185"))
      .toBe(419095185);
    expect(parsePersistedShipStationPhysicalShipmentId("shipstation_combined:419095185:order:34"))
      .toBe(419095185);
    expect(parsePersistedShipStationPhysicalShipmentId("provider_physical:v1:shipstation:419095185"))
      .toBe(419095185);
    expect(parsePersistedShipStationPhysicalShipmentId("shopify_fulfillment:419095185")).toBeNull();
    expect(parsePersistedShipStationPhysicalShipmentId("shipstation_shipment:not-a-number")).toBeNull();
    expect(parsePersistedShipStationPhysicalShipmentId(null)).toBeNull();
  });

  it("resolves provider-order linkage only from an exact compatible physical match", async () => {
    const {
      decideShipStationPhysicalMatch,
      decideShipStationProviderOrderLinkage,
    } = await loadModule();
    const physicalDecision = decideShipStationPhysicalMatch(
      { tracking_number: "9400150106151146065720" },
      [{
        shipmentId: 419095185,
        orderId: 715057545,
        orderKey: "echelon-oms-3033",
        trackingNumber: "9400150106151146065720",
      }],
    );

    expect(decideShipStationProviderOrderLinkage({
      external_fulfillment_id: "shipstation_shipment:419095185",
      shipping_engine: null,
      engine_order_ref: null,
      engine_shipment_ref: null,
      shipstation_order_id: null,
      shipstation_order_key: null,
    }, physicalDecision)).toMatchObject({
      kind: "match",
      providerOrderLinkage: {
        shippingEngine: "shipstation",
        engineOrderRef: "715057545",
        engineShipmentRef: "echelon-oms-3033",
        shipstationOrderId: 715057545,
        shipstationOrderKey: "echelon-oms-3033",
      },
    });

    expect(decideShipStationProviderOrderLinkage({
      external_fulfillment_id: "shipstation_shipment:419095186",
    }, physicalDecision)).toMatchObject({
      kind: "identity_conflict",
      reason: expect.stringContaining("does not match"),
    });

    expect(decideShipStationProviderOrderLinkage({
      external_fulfillment_id: "shipstation_shipment:419095185",
      engine_order_ref: "999",
    }, physicalDecision)).toMatchObject({
      kind: "identity_conflict",
      reason: expect.stringContaining("engine_order_ref=999"),
    });
  });

  it("rejects provider-order linkage when ShipStation omits required order identity", async () => {
    const {
      decideShipStationPhysicalMatch,
      decideShipStationProviderOrderLinkage,
    } = await loadModule();
    const physicalDecision = decideShipStationPhysicalMatch(
      { tracking_number: "TRACKING" },
      [{ shipmentId: 10, orderId: 20, orderKey: null, trackingNumber: "TRACKING" }],
    );

    expect(decideShipStationProviderOrderLinkage({
      external_fulfillment_id: "shipstation_shipment:10",
    }, physicalDecision)).toMatchObject({
      kind: "invalid_candidate",
      reason: "matching ShipStation shipment has no orderKey",
    });
  });

  it("never persists a dry-run decision", async () => {
    const { decideShipStationPhysicalMatch, shouldPersistEnrichment } = await loadModule();
    const match = decideShipStationPhysicalMatch(
      { tracking_number: "TRACKING" },
      [{ shipmentId: 10, trackingNumber: "TRACKING" }],
    );
    const noMatch = decideShipStationPhysicalMatch(
      { tracking_number: "TRACKING" },
      [],
    );

    expect(shouldPersistEnrichment("dry-run", match)).toBe(false);
    expect(shouldPersistEnrichment("execute", match)).toBe(true);
    expect(shouldPersistEnrichment("execute", noMatch)).toBe(false);
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
    expect(query.sql).toContain("s.shipstation_order_id");
    expect(query.sql).not.toContain("s.shipstation_order_id IS NOT NULL");
    expect(query.sql).toContain("external_fulfillment_id");
    expect(query.params).toEqual(["#59453", 4313]);
  });

  it("selects only missing provider-order linkage under the explicit linkage scope", async () => {
    const { buildCandidateSql } = await loadModule();
    const query = buildCandidateSql({
      scope: "provider-order-linkage",
      limit: null,
      orderNumber: null,
      wmsShipmentId: null,
    });

    expect(query.sql).toContain("s.external_fulfillment_id ~ '^shipstation_shipment:[0-9]+$'");
    expect(query.sql).toContain("s.external_fulfillment_id ~ '^shipstation_combined:[0-9]+:order:[0-9]+$'");
    expect(query.sql).toContain("s.external_fulfillment_id ~ '^provider_physical:v1:shipstation:[0-9]+$'");
    expect(query.sql).toContain("OR s.shipstation_order_id IS NULL");
    expect(query.sql).toContain("s.external_fulfillment_id,");
    expect(query.sql).not.toContain("LIMIT 25");
    expect(query.params).toEqual([]);
  });

  it("clears stale not-found review flags when enrichment writes a physical id", async () => {
    const {
      applyExternalFulfillmentIdSql,
      NOT_FOUND_REVIEW_REASON,
    } = await loadModule();
    const sql = applyExternalFulfillmentIdSql();

    expect(NOT_FOUND_REVIEW_REASON).toBe("physical_identity_not_found_after_enrichment");
    expect(sql).toContain("SET external_fulfillment_id = $1");
    expect(sql).toContain("WHEN review_reason = $5 THEN false");
    expect(sql).toContain("WHEN review_reason = $5 THEN NULL");
    expect(sql).toContain("AND NULLIF(BTRIM(COALESCE(external_fulfillment_id, '')), '') IS NULL");
    expect(sql).not.toContain("requires_review = false,");
  });

  it("atomically guards every prior identity field when writing provider-order linkage", async () => {
    const {
      applyProviderOrderLinkageSql,
      insertProviderOrderLinkageAuditSql,
    } = await loadModule();
    const sql = applyProviderOrderLinkageSql();
    const auditSql = insertProviderOrderLinkageAuditSql();

    expect(sql).toContain("SET shipping_engine = $1::varchar");
    expect(sql).toContain("engine_order_ref = $2::varchar");
    expect(sql).toContain("engine_shipment_ref = $3::varchar");
    expect(sql).toContain("shipstation_order_id = $4::integer");
    expect(sql).toContain("shipstation_order_key = $5::varchar");
    expect(sql).toContain("external_fulfillment_id IS NOT DISTINCT FROM $8::varchar");
    expect(sql).toContain("shipping_engine IS NOT DISTINCT FROM $9::varchar");
    expect(sql).toContain("engine_order_ref IS NOT DISTINCT FROM $10::varchar");
    expect(sql).toContain("engine_shipment_ref IS NOT DISTINCT FROM $11::varchar");
    expect(sql).toContain("shipstation_order_id IS NOT DISTINCT FROM $12::integer");
    expect(sql).toContain("shipstation_order_key IS NOT DISTINCT FROM $13::varchar");
    expect(sql).not.toContain("SET external_fulfillment_id");
    expect(sql).toContain("RETURNING");
    expect(auditSql).toContain("INSERT INTO wms.oms_wms_authority_cleanup_audit");
    expect(auditSql).toContain("'shipstation-provider-order-linkage'");
    expect(auditSql).toContain("$3::jsonb");
    expect(auditSql).toContain("$4::jsonb");
    expect(auditSql).toContain("$5::text");
  });
});
