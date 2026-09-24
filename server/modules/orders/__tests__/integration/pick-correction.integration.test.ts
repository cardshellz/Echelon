import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { PickCorrectionService, createPickCorrectionService } from "../../pick-correction.service";
import { assertNoOpenPickCorrection, observeMissingPick, readPickCorrection, requireCorrectivePick } from "../../../wms/pick-correction.repository";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const suite = url && disposable ? describe : describe.skip;
const now = new Date("2026-09-24T12:00:00Z");
const foundation = `CREATE SCHEMA wms;
CREATE TABLE wms.orders(id integer PRIMARY KEY,order_number text,warehouse_status text,on_hold integer);
CREATE TABLE wms.order_items(id integer PRIMARY KEY,order_id integer REFERENCES wms.orders,
  sku text,name text,barcode text,location text,quantity integer,picked_quantity integer);
CREATE TABLE wms.physical_shipments(id bigint PRIMARY KEY);
-- A narrow test movement journal: workflow tests exercise the real service/repository;
-- the existing inventory-owner suites separately prove lot/cost posting.
CREATE TABLE wms.test_pick_movements(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,quantity integer);
`;

suite("corrective picking durable PostgreSQL workflow", () => {
  let database: InventoryCutoverTestDatabase;
  let db: ReturnType<typeof drizzle>;
  let correctionId: number;
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable,
      foundation + readFileSync("migrations/0703_corrective_picking.sql", "utf8"));
    db = drizzle(database.pool);
  });
  afterAll(async () => { await database?.close(); });
  beforeEach(async () => {
    await database.pool.query(`TRUNCATE wms.orders,wms.physical_shipments,wms.test_pick_movements RESTART IDENTITY CASCADE;
      INSERT INTO wms.orders VALUES(1,'#TEST','shipped',0);
      INSERT INTO wms.order_items VALUES(10,1,'P5','Pack of five','12345','A-01',3,1);
      INSERT INTO wms.physical_shipments VALUES(20);`);
    await observe();
    correctionId = Number((await database.pool.query("SELECT id FROM wms.pick_corrections")).rows[0].id);
  });
  const observe = async (quantity = 3) => db.transaction(async tx => {
    await tx.execute(sql`SELECT id FROM wms.orders WHERE id=1 FOR UPDATE`);
    const item = await tx.execute(sql`SELECT picked_quantity FROM wms.order_items WHERE id=10`);
    await observeMissingPick(tx, { orderItemId: 10, physicalShipmentId: 20,
      declaredQuantity: quantity, pickedQuantity: item.rows[0].picked_quantity as number, occurredAt: now });
  });
  const read = () => readPickCorrection(db, correctionId);
  function service(fail = false) {
    const pick = vi.fn(async ({ correction, targetQuantity, actor }: Parameters<ConstructorParameters<typeof PickCorrectionService>[1]>[0]) => {
      await db.transaction(async tx => {
        await tx.execute(sql`SELECT id FROM wms.orders WHERE id=1 FOR UPDATE`);
        await tx.execute(sql`SELECT id FROM wms.order_items WHERE id=10 FOR UPDATE`);
        const current = await requireCorrectivePick(tx, { correctionId: correction.id,
          orderItemId: 10, targetPickedQuantity: targetQuantity, actor, expectedRevision: correction.revision });
        if (targetQuantity > current.pickedQuantity) {
          await tx.execute(sql`INSERT INTO wms.test_pick_movements(quantity) VALUES(${targetQuantity - current.pickedQuantity})`);
          await tx.execute(sql`UPDATE wms.order_items SET picked_quantity=${targetQuantity} WHERE id=10`);
        }
        if (fail) throw new Error("injected stock-owner failure");
      });
    });
    return { pick, service: new PickCorrectionService(db, pick, () => now) };
  }
  const answer = (answer: "yes" | "no", revision = 1) => ({ answer, expectedRevision: revision, commandId: randomUUID() });
  const scan = (pickedQuantity: number, revision = 2, barcode = "12345") => ({ pickedQuantity, expectedRevision: revision, barcode, commandId: randomUUID() });
  const movements = async () => (await database.pool.query("SELECT quantity FROM wms.test_pick_movements ORDER BY id")).rows;

  it("No saves work, moves no stock and survives the old shipment event", async () => {
    const { service: sut, pick } = service();
    expect(await sut.answer(correctionId, answer("no"), "picker")).toMatchObject({ state: "picking_required", answer: "no", pickedQuantity: 1 });
    await observe(); await observe();
    expect(await read()).toMatchObject({ answer: "no", state: "picking_required", revision: 2 });
    expect(pick).not.toHaveBeenCalled(); expect(await movements()).toEqual([]);
    await expect(assertNoOpenPickCorrection(db, 10)).rejects.toMatchObject({ code: "PICK_CORRECTION_REQUIRED" });
  });
  it("uses the confirmation owner without requiring a bin for an explicitly non-stock item", async () => {
    await database.pool.query("UPDATE wms.order_items SET location='UNASSIGNED' WHERE id=10");
    const storage = {
      getOrderItemById: vi.fn(async () => ({ id: 10, quantity: 3, inventoryTracking: false, catalogProductId: 5 })),
      getOrderById: vi.fn(async () => ({ warehouseId: 1 })),
      getAllWarehouseLocations: vi.fn(async () => []),
    };
    const pickItem = vi.fn(async () => {
      await database.pool.query("UPDATE wms.order_items SET picked_quantity=3 WHERE id=10");
      return { success: true as const, item: { pickedQuantity: 3 }, inventory: {} };
    });
    const sut = createPickCorrectionService(db, storage, { pickItem } as any, () => now);
    await expect(sut.answer(correctionId, answer("yes"), "picker")).resolves.toMatchObject({ state: "resolved" });
    expect(storage.getAllWarehouseLocations).not.toHaveBeenCalled();
    expect(pickItem).toHaveBeenCalledWith(10, expect.objectContaining({ warehouseLocationId: undefined,
      pickCorrectionId: correctionId, pickCorrectionRevision: 2 }));
    expect(await movements()).toEqual([]);
  });
  it("Yes records only missing units and concurrent replay never doubles the movement", async () => {
    const { service: sut } = service(); const command = answer("yes");
    await Promise.all([sut.answer(correctionId, command, "picker"), sut.answer(correctionId, command, "picker")]);
    await sut.answer(correctionId, command, "picker");
    expect(await read()).toMatchObject({ pickedQuantity: 3, state: "resolved" });
    expect(await movements()).toEqual([{ quantity: 2 }]);
    await expect(assertNoOpenPickCorrection(db, 10)).resolves.toBeUndefined();
    expect((await database.pool.query("SELECT warehouse_status FROM wms.orders")).rows[0].warehouse_status).toBe("shipped");
  });
  it("No permits partial corrective scans without touching the previously picked unit", async () => {
    const { service: sut } = service();
    await sut.answer(correctionId, answer("no"), "picker");
    const first = scan(2);
    expect(await sut.complete(correctionId, first, "picker")).toMatchObject({ pickedQuantity: 2, state: "picking_required" });
    await sut.complete(correctionId, first, "picker");
    expect(await sut.complete(correctionId, scan(3, 3), "picker")).toMatchObject({ state: "resolved" });
    expect(await movements()).toEqual([{ quantity: 1 }, { quantity: 1 }]);
  });
  it("rejects wrong item, another operator, stale revision and command-key reuse", async () => {
    const { service: sut } = service(); const command = answer("no");
    await sut.answer(correctionId, command, "picker");
    await expect(sut.complete(correctionId, scan(3, 2, "WRONG"), "picker")).rejects.toMatchObject({ code: "WRONG_ITEM" });
    await expect(sut.complete(correctionId, scan(3), "other")).rejects.toMatchObject({ code: "CORRECTION_CHANGED" });
    await expect(sut.complete(correctionId, scan(3, 1), "picker")).rejects.toMatchObject({ code: "CORRECTION_CHANGED" });
    await expect(sut.answer(correctionId, { ...command, answer: "yes" }, "picker")).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await movements()).toEqual([]);
  });
  it("rolls back failed movement but retains the Yes and supports retry after sign-in", async () => {
    const { service: broken } = service(true);
    await expect(broken.answer(correctionId, answer("yes"), "picker")).rejects.toThrow("injected");
    expect(await read()).toMatchObject({ state: "picking_required", answer: "yes", pickedQuantity: 1, reviewReason: "injected stock-owner failure" });
    expect(await movements()).toEqual([]);
    const { service: repaired } = service();
    await repaired.answer(correctionId, answer("yes", (await read()).revision), "picker");
    expect(await movements()).toEqual([{ quantity: 2 }]);
  });
  it("recovers a crash after committed pick progress but before closing the correction", async () => {
    const { service: sut } = service();
    await sut.answer(correctionId, answer("no"), "picker");
    await database.pool.query("UPDATE wms.order_items SET picked_quantity=3 WHERE id=10");
    // Use the original scan audit to reproduce a lost completion response.
    const command = scan(3);
    await database.pool.query("UPDATE wms.order_items SET picked_quantity=2 WHERE id=10");
    const failing = new PickCorrectionService(db, async () => {
      await database.pool.query("UPDATE wms.order_items SET picked_quantity=3 WHERE id=10");
      throw new Error("lost response after commit");
    }, () => now);
    await expect(failing.complete(correctionId, command, "picker")).resolves.toMatchObject({ state: "resolved" });
    await sut.complete(correctionId, command, "picker");
    expect(await read()).toMatchObject({ state: "resolved", pickedQuantity: 3 });
    expect(await movements()).toEqual([]);
  });
  it("fences two different scans from one stale screen before moving inventory", async () => {
    const { service: sut } = service();
    await sut.answer(correctionId, answer("no"), "picker");
    const outcomes = await Promise.allSettled([
      sut.complete(correctionId, scan(2), "picker"), sut.complete(correctionId, scan(2), "picker"),
    ]);
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.status === "rejected")).toHaveLength(1);
    expect(await movements()).toEqual([{ quantity: 1 }]);
  });
  it("does not apply an old Yes to a newer package declaration", async () => {
    await database.pool.query("UPDATE wms.order_items SET quantity=4 WHERE id=10");
    const { service: sut } = service(true); const command = answer("yes");
    await expect(sut.answer(correctionId, command, "picker")).rejects.toThrow();
    await observe(4);
    await expect(sut.answer(correctionId, command, "picker")).rejects.toMatchObject({ code: "CORRECTION_CHANGED" });
    expect(await movements()).toEqual([]);
  });
  it("withdraws work only when the authoritative contents are reduced", async () => {
    const { service: sut } = service();
    await sut.answer(correctionId, answer("no"), "picker");
    await observe(0);
    expect(await read()).toMatchObject({ state: "resolved" });
    expect(await movements()).toEqual([]);
  });
  it("fences a changed declaration between a saved Yes and the inventory transaction", async () => {
    const { pick: owner } = service();
    const interrupted = new PickCorrectionService(db, async input => {
      await observe(0);
      await observe(3);
      const { service: later } = service();
      await later.answer(correctionId, answer("no", (await read()).revision), "picker");
      await owner(input);
    }, () => now);
    await expect(interrupted.answer(correctionId, answer("yes"), "picker"))
      .rejects.toMatchObject({ code: "CORRECTION_CHANGED" });
    expect(await read()).toMatchObject({ state: "picking_required", answer: "no", reviewReason: null });
    expect(await movements()).toEqual([]);
  });
  it("rejects an old scan after withdrawal and reintroduction of the same declared quantity", async () => {
    const { service: broken } = service(true);
    await broken.answer(correctionId, answer("no"), "picker");
    const command = scan(3);
    await expect(broken.complete(correctionId, command, "picker")).rejects.toThrow("injected");
    await observe(0); await observe(3);
    const { service: repaired } = service();
    await repaired.answer(correctionId, answer("no", (await read()).revision), "picker");
    await expect(repaired.complete(correctionId, command, "picker"))
      .rejects.toMatchObject({ code: "CORRECTION_CHANGED" });
    expect(await movements()).toEqual([]);
  });
  it("protects audit evidence against update/delete and rejects invalid answers", async () => {
    const { service: sut } = service();
    await expect(sut.answer(correctionId, { ...answer("no"), answer: "check_later" }, "picker")).rejects.toThrow();
    await expect(database.pool.query("UPDATE wms.pick_correction_events SET actor='someone else'")).rejects.toThrow("append-only");
    await expect(database.pool.query("DELETE FROM wms.pick_correction_events")).rejects.toThrow("append-only");
  });
});
