import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { ReceivingService } from "../../receiving.service";
import { receivingUnitVersion } from "../../receiving-unit-contract";

const NOW = new Date("2026-09-06T12:00:00.000Z");
const RECORDED_AT = new Date("2026-09-05T12:00:00.000Z");
const ACTOR = "receiving-operator";
const dialect = new PgDialect();

const recordedLine = () => ({
  id: 11, receivingOrderId: 10, productId: 1, productVariantId: 100,
  purchaseOrderLineId: null as number | null, inboundShipmentLineId: null as number | null,
  unitsPerVariantSnapshot: 250 as number | null, expectedQty: 4, receivedQty: 2, damagedQty: 1,
  putawayLocationId: 99, putawayComplete: 0, status: "partial", unitCost: 4, unitCostMills: 375,
  updatedAt: RECORDED_AT,
});
type TestLine = ReturnType<typeof recordedLine>;

/** Stateful owner boundary, not a database substitute: rollback/lock exclusion
 * are exercised separately against PostgreSQL. This harness inspects the actual
 * service's validated writes, executor forwarding and audit payloads. */
function harness(options: {
  line?: Partial<TestLine>;
  catalogFactor?: number;
  catalogProductId?: number;
  catalogActive?: boolean;
  orderStatus?: string;
  orderSource?: { sourceType: string; purchaseOrderId: number; inboundShipmentId: number };
  purchaseSource?: { id: number; purchaseOrderId: number; productId: number; lineType: string };
  shipmentSource?: { id: number; inboundShipmentId: number; purchaseOrderId: number; purchaseOrderLineId: number; qtyShipped: number };
} = {}) {
  let line = { ...recordedLine(), ...options.line };
  let order = { id: 10, status: options.orderStatus ?? "open", sourceType: "blind", vendorId: null, updatedAt: RECORDED_AT, ...options.orderSource };
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const tx = {
    execute: vi.fn(async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
      const rendered = dialect.sqlToQuery(query);
      queries.push(rendered);
      if (rendered.sql.includes("FROM catalog.product_variants")) {
        return { rows: [{ id: rendered.params[0], product_id: options.catalogProductId ?? 1,
          units_per_variant: options.catalogFactor ?? 1, is_active: options.catalogActive ?? true }] };
      }
      if (rendered.sql.includes("FROM procurement.purchase_orders")) return { rows: options.purchaseSource ? [{ id: options.purchaseSource.purchaseOrderId }] : [] };
      if (rendered.sql.includes("FROM procurement.purchase_order_lines")) return { rows: options.purchaseSource ? [{ id: options.purchaseSource.id }] : [] };
      if (rendered.sql.includes("FROM procurement.inbound_shipment_lines")) {
        const source = options.shipmentSource;
        return { rows: source && rendered.params[0] === source.id ? [{ inbound_shipment_id: source.inboundShipmentId,
          purchase_order_id: source.purchaseOrderId, purchase_order_line_id: source.purchaseOrderLineId, qty_shipped: source.qtyShipped }] : [] };
      }
      if (rendered.sql.includes("SELECT receiving_order_id")) return { rows: [{ receiving_order_id: order.id }] };
      if (rendered.sql.includes("FROM procurement.receiving_orders")) return { rows: [{ id: order.id }] };
      if (rendered.sql.includes("FROM procurement.receiving_lines")) return { rows: [{ id: line.id }] };
      if (rendered.sql.includes("INSERT INTO public.audit_events")) return { rows: [] };
      throw new Error(`Unimplemented receiving test query: ${rendered.sql}`);
    }),
  };
  const storage = {
    getPurchaseOrderLineById: vi.fn(async (id: number, executor: unknown) => {
      expect(executor).toBe(tx);
      return options.purchaseSource?.id === id ? { ...options.purchaseSource } : undefined;
    }),
    getReceivingOrderById: vi.fn(async () => ({ ...order })),
    getReceivingLineById: vi.fn(async () => ({ ...line })),
    getReceivingLines: vi.fn(async () => [{ ...line }]),
    updateReceivingLine: vi.fn(async (_id: number, patch: Partial<TestLine>, executor: unknown) => {
      expect(executor).toBe(tx);
      line = { ...line, ...patch };
      return { ...line };
    }),
    updateReceivingOrder: vi.fn(async (_id: number, patch: Partial<typeof order>, executor: unknown) => {
      expect(executor).toBe(tx);
      order = { ...order, ...patch };
      return { ...order };
    }),
  };
  const db = { transaction: vi.fn(async <T>(work: (executor: typeof tx) => Promise<T>) => work(tx)) };
  const inventory = { receiveInventory: vi.fn() };
  const service = new ReceivingService(db as any, inventory as any, {} as any, storage as any,
    null, null, null, null, null, null, () => NOW);
  return { service, storage, tx, db, inventory, queries, line: () => ({ ...line }),
    version: () => receivingUnitVersion(line) };
}

function expectNoWrites(test: ReturnType<typeof harness>) {
  expect(test.storage.updateReceivingLine).not.toHaveBeenCalled();
  expect(test.storage.updateReceivingOrder).not.toHaveBeenCalled();
  expect(test.inventory.receiveInventory).not.toHaveBeenCalled();
  expect(test.queries.some((query) => query.sql.includes("INSERT INTO public.audit_events"))).toBe(false);
}

describe("ReceivingService frozen count commands", () => {
  it("converts all counts exactly, preserves per-piece cost, and audits the original actor and clock", async () => {
    const test = harness();
    const before = test.line();
    const request = { productVariantId: 101, expectedUnitVersion: test.version() };
    const result = await test.service.updateLine(11, request, ACTOR);
    expect(request).toEqual({ productVariantId: 101, expectedUnitVersion: receivingUnitVersion(before) });
    expect(result).toMatchObject({ productVariantId: 101, unitsPerVariantSnapshot: 1,
      expectedQty: 1000, receivedQty: 500, damagedQty: 250, status: "partial",
      unitCost: 4, unitCostMills: 375, updatedAt: NOW, unitVersion: test.version() });
    expect(test.storage.updateReceivingLine).toHaveBeenCalledOnce();
    const audit = test.queries.find((query) => query.sql.includes("INSERT INTO public.audit_events"))!;
    expect(audit.params).toContain(ACTOR);
    expect(audit.params).toContain(NOW);
    expect(audit.params).toContain("receiving-line:11");
    const auditObjects = audit.params.filter((value): value is string => typeof value === "string" && value.startsWith("{"))
      .map((value) => JSON.parse(value));
    expect(auditObjects).toEqual(expect.arrayContaining([
      expect.objectContaining({ before: expect.objectContaining({ receivedQty: 2, unitsPerVariantSnapshot: 250 }),
        after: expect.objectContaining({ receivedQty: 500, unitsPerVariantSnapshot: 1 }) }),
      { receivingOrderId: 10, receivingLineId: 11, legacyUnitConfirmed: false },
    ]));
  });

  it("rejects a stale version before modifying counts or querying the catalog", async () => {
    const test = harness();
    await expect(test.service.updateLine(11, { receivedQty: 3, expectedUnitVersion: "a".repeat(64) }, ACTOR))
      .rejects.toMatchObject({ statusCode: 409, details: { code: "RECEIVING_UNIT_VERSION_CONFLICT" } });
    expectNoWrites(test);
    expect(test.queries.some((query) => query.sql.includes("catalog.product_variants"))).toBe(false);
  });

  it("preserves an explicitly entered zero rather than replacing it with expected quantity", async () => {
    const test = harness();
    const result = await test.service.updateLine(11, { receivedQty: 0, expectedUnitVersion: test.version() }, ACTOR);
    expect(result).toMatchObject({ expectedQty: 4, receivedQty: 0, status: "pending", unitsPerVariantSnapshot: 250 });
  });

  it("requires explicit legacy confirmation and retains the attested counts", async () => {
    const test = harness({ line: { unitsPerVariantSnapshot: null }, catalogFactor: 250 });
    const result = await test.service.updateLine(11, { productVariantId: 100, confirmLegacyUnit: true, expectedUnitsPerVariant: 250,
      expectedUnitVersion: test.version() }, ACTOR);
    expect(result).toMatchObject({ expectedQty: 4, receivedQty: 2, damagedQty: 1, unitsPerVariantSnapshot: 250 });
    const audit = test.queries.find((query) => query.sql.includes("INSERT INTO public.audit_events"))!;
    expect(audit.params).toContain(JSON.stringify({ receivingOrderId: 10, receivingLineId: 11, legacyUnitConfirmed: true }));
  });

  it.each([false, true])("rejects legacy reinterpretation when confirmation=%s", async (confirmation) => {
    const test = harness({ line: { unitsPerVariantSnapshot: null }, catalogFactor: 250 });
    await expect(test.service.updateLine(11, { productVariantId: confirmation ? 101 : 100,
      ...(confirmation ? { confirmLegacyUnit: true, expectedUnitsPerVariant: 250 } : {}), expectedUnitVersion: test.version() }, ACTOR))
      .rejects.toMatchObject({ statusCode: 409, details: { code: "RECEIVING_UNIT_CONFIRMATION_REQUIRED" } });
    expectNoWrites(test);
  });

  it("rejects an inexact damaged count even when the expected and received counts divide exactly", async () => {
    const test = harness({ catalogFactor: 500 });
    await expect(test.service.updateLine(11, { productVariantId: 101, expectedUnitVersion: test.version() }, ACTOR))
      .rejects.toMatchObject({ statusCode: 409, details: { code: "RECEIVING_UNIT_CONVERSION_INEXACT", field: "damagedQty" } });
    expectNoWrites(test);
  });

  it.each([
    [{ catalogProductId: 2 }, "RECEIVING_VARIANT_PRODUCT_MISMATCH"],
    [{ catalogActive: false }, "RECEIVING_VARIANT_REVIEW_REQUIRED"],
  ] as const)("rejects an invalid catalog selection %j", async (options, code) => {
    const test = harness(options);
    await expect(test.service.updateLine(11, { productVariantId: 101, expectedUnitVersion: test.version() }, ACTOR))
      .rejects.toMatchObject({ statusCode: 409, details: { code } });
    expectNoWrites(test);
  });

  it("allows exact unit conversion for a shipment source but prevents rewriting its expected pieces", async () => {
    const test = harness({
      line: { inboundShipmentLineId: 55, purchaseOrderLineId: 21 },
      orderSource: { sourceType: "shipment", purchaseOrderId: 20, inboundShipmentId: 30 },
      purchaseSource: { id: 21, purchaseOrderId: 20, productId: 1, lineType: "product" },
      shipmentSource: { id: 55, inboundShipmentId: 30, purchaseOrderId: 20, purchaseOrderLineId: 21, qtyShipped: 1000 },
    });
    await expect(test.service.updateLine(11, { expectedQty: 5, expectedUnitVersion: test.version() }, ACTOR))
      .rejects.toMatchObject({ statusCode: 409, details: { code: "RECEIVING_EXPECTED_SOURCE_IMMUTABLE" } });
    expectNoWrites(test);
    const result = await test.service.updateLine(11, { productVariantId: 101, expectedUnitVersion: test.version() }, ACTOR);
    expect(result).toMatchObject({ expectedQty: 1000, unitsPerVariantSnapshot: 1, inboundShipmentLineId: 55 });
  });

  it.each([-1, 0.5, 2_147_483_648])("rejects invalid received count %s before writes", async (receivedQty) => {
    const test = harness();
    await expect(test.service.updateLine(11, { receivedQty, expectedUnitVersion: test.version() }, ACTOR))
      .rejects.toMatchObject({ statusCode: 400 });
    expectNoWrites(test);
  });

  it("rejects a count whose converted piece total exceeds the supported database range", async () => {
    const test = harness();
    await expect(test.service.updateLine(11, { receivedQty: 10_000_000, expectedUnitVersion: test.version() }, ACTOR))
      .rejects.toMatchObject({ statusCode: 400, details: { code: "INVALID_RECEIVING_UNIT_QUANTITY", field: "receivedQty in pieces" } });
    expectNoWrites(test);
  });

  it.each([
    [null, 250, "RECEIVING_UNIT_CONFIRMATION_REQUIRED"],
    [250, 500, "RECEIVING_UNIT_SOURCE_CHANGED"],
  ] as const)("blocks close for frozen factor %s and catalog factor %s before inventory writes", async (snapshot, catalogFactor, code) => {
    const test = harness({ line: { unitsPerVariantSnapshot: snapshot }, catalogFactor });
    await expect(test.service.close(10, ACTOR)).rejects.toMatchObject({ statusCode: 409, details: { code } });
    expectNoWrites(test);
  });

  it.each([
    [{ line: { unitsPerVariantSnapshot: null } }, "RECEIVING_UNIT_CONFIRMATION_REQUIRED"],
    [{ catalogFactor: 500 }, "RECEIVING_UNIT_SOURCE_CHANGED"],
    [{ line: { receivedQty: null as unknown as number } }, "INVALID_RECEIVING_UNIT_QUANTITY"],
  ] as const)("complete-all rejects unresolved or malformed counts %j before any writes", async (options, code) => {
    const test = harness(options);
    await expect(test.service.completeAllLines(10, { expectedUnitVersions: [{ lineId: 11, unitVersion: test.version() }] }, ACTOR))
      .rejects.toMatchObject({ details: { code } });
    expectNoWrites(test);
  });

  it.each([
    [[], "RECEIVING_UNIT_VERSION_REQUIRED"],
    [[{ lineId: 11, unitVersion: "a".repeat(64) }], "RECEIVING_UNIT_VERSION_CONFLICT"],
    [[{ lineId: 12, unitVersion: "a".repeat(64) }], "RECEIVING_UNIT_VERSION_CONFLICT"],
  ])("complete-all validates the exact reviewed line set %j", async (expectedUnitVersions, code) => {
    const test = harness();
    await expect(test.service.completeAllLines(10, { expectedUnitVersions }, ACTOR))
      .rejects.toMatchObject({ statusCode: 409, details: { code } });
    expectNoWrites(test);
  });

  it("complete-all preserves entered partial quantities and reports their real status", async () => {
    const test = harness({ catalogFactor: 250, line: { status: "pending" } });
    const result = await test.service.completeAllLines(10, { expectedUnitVersions: [{ lineId: 11, unitVersion: test.version() }] }, ACTOR);
    expect(result.updated).toBe(1);
    expect(result.order.lines).toEqual([expect.objectContaining({ receivedQty: 2, expectedQty: 4, status: "partial", unitVersion: test.version() })]);
    const audit = test.queries.find((query) => query.sql.includes("INSERT INTO public.audit_events"))!;
    expect(audit.params).toContain(NOW);
    expect(audit.params).toContain(ACTOR);
  });
});
