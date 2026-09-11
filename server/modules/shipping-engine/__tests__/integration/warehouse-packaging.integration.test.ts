import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ChannelPackagingRepository } from "../../infrastructure/channel-packaging.repository";
import { SharedShippingConfigurationRepository } from "../../infrastructure/shared-configuration.repository";
import { SHARED_SHIPPING_LEGACY_FIXTURE_SQL } from "./fixtures/shared-shipping-legacy";
import { saveCatalogBoxSchema } from "@shared/shipping/packaging-policy";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { shippingBoxCatalog, shippingPackPlanParcels } from "@shared/schema/shipping.schema";

const enabled =
  Boolean(process.env.ECHELON_TEST_DATABASE_URL) &&
  process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
describe.skipIf(!enabled)("warehouse-owned packaging commands", () => {
  const database = `warehouse_packaging_${randomUUID().replaceAll("-", "")}`;
  const now = new Date("2026-09-10T12:00:00Z");
  let admin: Pool,
    db: Pool,
    repo: ChannelPackagingRepository,
    shared: SharedShippingConfigurationRepository;
  const actor = "packaging-admin";
  beforeAll(async () => {
    admin = new Pool({
      connectionString: process.env.ECHELON_TEST_DATABASE_URL,
    });
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(process.env.ECHELON_TEST_DATABASE_URL!);
    url.pathname = `/${database}`;
    db = new Pool({ connectionString: url.toString() });
    repo = new ChannelPackagingRepository(db);
    shared = new SharedShippingConfigurationRepository(db);
    await db.query(SHARED_SHIPPING_LEGACY_FIXTURE_SQL);
    await db.query(`ALTER TABLE shipping.pack_plan_parcels
      ADD COLUMN length_mm integer, ADD COLUMN width_mm integer, ADD COLUMN height_mm integer;
      INSERT INTO shipping.pack_plan_parcels VALUES(1,203,152,0)`);
    for (const name of [
      "238_shared_packaging_and_program_charges.sql",
      "239_packaging_suite_lifecycle.sql",
      "241_channel_packaging_policies.sql",
      "243_warehouse_packaging_availability.sql",
      "244_box_dimension_precision.sql",
    ])
      await db.query(readFileSync(resolve("migrations", name), "utf8"));
    await db.query(
      "INSERT INTO channels.channels VALUES(21,'Dropship','internal','manual','active',NULL),(22,'Shopify','internal','shopify','active',NULL)",
    );
  });
  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
      await admin.end();
    }
  });
  const create = async (
    code: string,
    branding: "unbranded" | "branded" = "unbranded",
  ) => {
    const input = saveCatalogBoxSchema.parse({
      code,
      name: code,
      kind: "box",
      lengthMm: 100,
      widthMm: 100,
      heightMm: 100,
      tareWeightGrams: 10,
      costCents: 20,
      fillFactorBps: 10000,
      isActive: true,
      branding,
      expectedRevision: 0,
      commandId: randomUUID(),
    });
    return { input, ...(await repo.saveBox(input, actor, now)) };
  };
  const warehouseTargets = async (ids: number[]) =>
    (await repo.overview()).warehouses
      .filter((w) => ids.includes(w.id))
      .map((w) => ({ id: w.id, revision: w.packagingRevision }));
  const availability = async (
    ids: number[],
    boxIds: number[],
    available = true,
  ) =>
    repo.saveAvailability(
      {
        commandId: randomUUID(),
        warehouses: await warehouseTargets(ids),
        boxIds,
        available,
      },
      actor,
      now,
    );
  const createSuite = async (name: string, boxIds: number[]) =>
    shared.saveSuite(
      { commandId: randomUUID(), name, boxIds, expectedRevision: 0 },
      actor,
      now,
    );

  it("migrates existing measurements exactly and keeps numeric API/parcel contracts", async () => {
    const orm = drizzle(db);
    expect(await orm.select({ lengthMm: shippingBoxCatalog.lengthMm, widthMm: shippingBoxCatalog.widthMm,
      heightMm: shippingBoxCatalog.heightMm }).from(shippingBoxCatalog)
      .where(eq(shippingBoxCatalog.code, "migrated-dropship-7")))
      .toEqual([{ lengthMm: 203, widthMm: 152, heightMm: 102 }]);
    const parcelDimensions = { lengthMm: shippingPackPlanParcels.lengthMm,
      widthMm: shippingPackPlanParcels.widthMm, heightMm: shippingPackPlanParcels.heightMm };
    expect(await orm.select(parcelDimensions).from(shippingPackPlanParcels))
      .toEqual([{ lengthMm: 203, widthMm: 152, heightMm: 0 }]);
    const measured = { lengthMm: 209.55, widthMm: 158.75, heightMm: 107.9754 };
    await orm.update(shippingPackPlanParcels).set(measured).where(eq(shippingPackPlanParcels.id, 1));
    expect(await orm.select(parcelDimensions).from(shippingPackPlanParcels)).toEqual([measured]);
    expect((await db.query("SELECT height_mm FROM shipping.pack_plan_parcels WHERE id=1")).rows[0].height_mm)
      .toBe("107.9754");
    await expect(db.query("UPDATE shipping.pack_plan_parcels SET height_mm='NaN' WHERE id=1"))
      .rejects.toMatchObject({ code: "23514" });
  });

  it("saves, audits, replays and resolves fractional box dimensions without losing precision", async () => {
    const input = saveCatalogBoxSchema.parse({
      code: "PRECISION", name: "Measured 8-inch box", kind: "box", branding: "unbranded",
      lengthMm: 203.2254, widthMm: 152.4, heightMm: 101.6,
      outerLengthMm: 209.55, outerWidthMm: 158.75, outerHeightMm: 107.9754,
      tareWeightGrams: 45, costCents: 25, fillFactorBps: 8500, isActive: true,
      expectedRevision: 0, commandId: randomUUID(),
    });
    const saved = await repo.saveBox(input, actor, now);
    expect(saved.box).toMatchObject({ lengthMm: 203.2254, outerHeightMm: 107.9754 });
    expect(await repo.saveBox(input, actor, now)).toEqual(saved);
    const journal = await db.query("SELECT before_state,after_state FROM shipping.configuration_commands WHERE command_id=$1", [input.commandId]);
    expect(journal.rows).toHaveLength(1);
    expect(journal.rows[0].after_state.box.lengthMm).toBe(203.2254);
    const typed = await drizzle(db).select().from(shippingBoxCatalog).where(eq(shippingBoxCatalog.id, saved.box.id));
    expect(typed[0]).toMatchObject({ lengthMm: 203.2254, widthMm: 152.4, outerHeightMm: 107.9754 });
    await availability([1], [saved.box.id]);
    const suite = await createSuite("Precise cartons", [saved.box.id]);
    await db.query("INSERT INTO channels.channels VALUES(900,'Precision channel','internal','manual','active',NULL)");
    await repo.savePolicy({ channelId: 900, defaultSuiteId: suite.id, requirement: "any", overrides: [],
      expectedRevision: 0, commandId: randomUUID() }, actor, now);
    expect((await shared.loadPackaging("internal", 1, 900)).boxes[0])
      .toMatchObject({ lengthMm: 203.2254, outerHeightMm: 107.9754 });
    await shared.saveAssignment({ channel: "internal", warehouseId: 1, suiteId: suite.id,
      expectedRevision: 0, commandId: randomUUID() }, actor, now);
    expect((await shared.loadPackaging("internal", 1)).boxes[0])
      .toMatchObject({ lengthMm: 203.2254, outerHeightMm: 107.9754 });
    const competing = await Promise.allSettled([202.1, 202.2].map((lengthMm) => repo.saveBox({ ...input,
      id: saved.box.id, expectedRevision: 1, lengthMm, commandId: randomUUID() }, actor, now)));
    expect(competing.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(competing.filter((result) => result.status === "rejected")).toHaveLength(1);
    const updated = await drizzle(db).select().from(shippingBoxCatalog).where(eq(shippingBoxCatalog.id, saved.box.id));
    expect(updated[0].configurationRevision).toBe(2);
    expect([202.1, 202.2]).toContain(updated[0].lengthMm);
    expect(updated[0].outerHeightMm).toBe(107.9754);
    for (const invalid of ["NaN", "2147483648"]) {
      await expect(db.query("UPDATE shipping.box_catalog SET length_mm=$1 WHERE id=$2", [invalid, saved.box.id]))
        .rejects.toMatchObject({ code: "23514" });
    }
  });

  it("corrects confirmed named inch sizes once, preserving other settings and conflicting measurements", async () => {
    const client = await db.connect();
    const migration = readFileSync(resolve("migrations/246_correct_legacy_box_dimensions.sql"), "utf8");
    const sizes = [[10, 8, 4], [10, 8, 6], [10, 8, 8], [12, 10, 6],
      [13, 10, 9], [15, 12, 7], [16, 7, 8], [16, 8, 11], [8.125, 6, 4]];
    try {
      await client.query("BEGIN");
      for (const dimensions of sizes) {
        const label = dimensions.join("x");
        await client.query(`INSERT INTO shipping.box_catalog
          (code,name,kind,length_mm,width_mm,height_mm,tare_weight_grams,cost_cents,
            fill_factor_bps,is_active,branding,configuration_revision)
          VALUES($1,$2,'box',$3,$4,$5,31,27,8500,true,'unbranded',4)`,
          [`BOX-${label}`, `Box ${label}`, ...dimensions.map((inches) => Math.round(inches * 25.4))]);
      }
      // One axis has already been corrected; the remaining axes still need repair.
      await client.query("UPDATE shipping.box_catalog SET width_mm=203.2 WHERE code='BOX-10x8x6'");
      await client.query(`UPDATE shipping.box_catalog SET outer_length_mm=260,
        outer_width_mm=210,outer_height_mm=110 WHERE code='BOX-10x8x4'`);
      await client.query(`INSERT INTO shipping.box_catalog
        (code,name,kind,length_mm,width_mm,height_mm,tare_weight_grams,cost_cents,fill_factor_bps,is_active)
        VALUES
        ('BOX-8x8x8','Box 8x8x8','box',203.2,203.2,203.2,0,0,8500,true),
        ('BOX-9x8x7','Box 9x8x7','box',220,203,178,0,0,8500,true),
        ('BOX-7x7x7','Box 7x7x7 (custom)','box',178,178,178,0,0,8500,true),
        ('OTHER-10x8x4','Box 10x8x4','box',254,203,102,0,0,8500,true),
        ('BOX-6x6x6','Custom measured carton','box',152,152,152,0,0,8500,true),
        ('BOX-5x5x5','Box 5x5x5','mailer',127,127,127,0,0,8500,true),
        ('BOX-0x8x4','Box 0x8x4','box',1,203,102,0,0,8500,true),
        ('BOX-6x8x4','Box 6x8x4','box',152,203,102,0,0,8500,true)`);
      await client.query(`UPDATE shipping.box_catalog SET outer_length_mm=152,
        outer_width_mm=210,outer_height_mm=110 WHERE code='BOX-6x8x4'`);
      const before = (await client.query("SELECT * FROM shipping.box_catalog ORDER BY id")).rows;
      const parcels = (await client.query("SELECT * FROM shipping.pack_plan_parcels ORDER BY id")).rows;
      const stocks = (await client.query("SELECT * FROM shipping.box_warehouse_stock ORDER BY box_id,warehouse_id")).rows;
      const suites = (await client.query("SELECT * FROM shipping.box_suite_members ORDER BY suite_id,revision,box_id")).rows;
      const notices: string[] = [];
      const onNotice = (notice: { message?: string }) => notices.push(notice.message ?? "");
      client.on("notice", onNotice);
      try { await client.query(migration); } finally { client.removeListener("notice", onNotice); }
      expect(notices.some((notice) => notice.includes("outer dimensions conflict"))).toBe(true);
      expect(notices.some((notice) => notice.includes("name/code disagree"))).toBe(true);
      const after = (await client.query("SELECT * FROM shipping.box_catalog ORDER BY id")).rows;
      const correctedCodes = new Set(sizes.map((size) => `BOX-${size.join("x")}`));
      for (let i = 0; i < before.length; i++) {
        if (!correctedCodes.has(before[i].code)) {
          expect(after[i]).toEqual(before[i]);
          continue;
        }
        const dimensions = sizes.find((size) => `BOX-${size.join("x")}` === before[i].code)!;
        expect(after[i]).toEqual({ ...before[i],
          length_mm: (dimensions[0] * 25.4).toFixed(4),
          width_mm: (dimensions[1] * 25.4).toFixed(4),
          height_mm: (dimensions[2] * 25.4).toFixed(4),
          configuration_revision: 5, updated_at: expect.any(Date) });
      }
      const audit = (await client.query(`SELECT * FROM shipping.configuration_commands
        WHERE actor_id='migration:246_correct_legacy_box_dimensions' ORDER BY resource_key`)).rows;
      expect(audit).toHaveLength(sizes.length);
      for (const event of audit) {
        const previous = before.find((row) => row.id === event.before_state.id);
        expect(event.before_state.length_mm).toBe(Number(previous.length_mm));
        expect(event.after_state.box.configuration_revision).toBe(5);
        expect(event.request_hash).toMatch(/^[a-f0-9]{64}$/);
      }
      await client.query(migration);
      expect((await client.query("SELECT * FROM shipping.box_catalog ORDER BY id")).rows).toEqual(after);
      expect((await client.query(`SELECT * FROM shipping.configuration_commands
        WHERE actor_id='migration:246_correct_legacy_box_dimensions' ORDER BY resource_key`)).rows).toEqual(audit);
      expect((await client.query("SELECT * FROM shipping.pack_plan_parcels ORDER BY id")).rows).toEqual(parcels);
      expect((await client.query("SELECT * FROM shipping.box_warehouse_stock ORDER BY box_id,warehouse_id")).rows).toEqual(stocks);
      expect((await client.query("SELECT * FROM shipping.box_suite_members ORDER BY suite_id,revision,box_id")).rows).toEqual(suites);
      // Do not reapply the repair over a subsequent administrator measurement.
      await client.query("UPDATE shipping.box_catalog SET width_mm=203,configuration_revision=6 WHERE code='BOX-10x8x4'");
      await client.query(migration);
      expect((await client.query("SELECT width_mm,configuration_revision FROM shipping.box_catalog WHERE code='BOX-10x8x4'")).rows)
        .toEqual([{ width_mm: "203.0000", configuration_revision: 6 }]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("rolls dimension changes back if their audit cannot be recorded", async () => {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO shipping.box_catalog
        (code,name,kind,length_mm,width_mm,height_mm,tare_weight_grams,cost_cents,fill_factor_bps,is_active)
        VALUES('BOX-10x8x4','Box 10x8x4','box',254,203,102,0,0,8500,true)`);
      await client.query(`CREATE FUNCTION shipping.reject_dimension_audit_test() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test audit failure'; END $$;
        CREATE TRIGGER reject_dimension_audit_test BEFORE INSERT ON shipping.configuration_commands
        FOR EACH ROW EXECUTE FUNCTION shipping.reject_dimension_audit_test()`);
      await client.query("SAVEPOINT before_correction");
      await expect(client.query(readFileSync(resolve("migrations/246_correct_legacy_box_dimensions.sql"), "utf8")))
        .rejects.toThrow("test audit failure");
      await client.query("ROLLBACK TO SAVEPOINT before_correction");
      expect((await client.query("SELECT width_mm,height_mm,configuration_revision FROM shipping.box_catalog WHERE code='BOX-10x8x4'")).rows)
        .toEqual([{ width_mm: "203.0000", height_mm: "102.0000", configuration_revision: 1 }]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("metadata edits never rewrite availability; new boxes start nowhere", async () => {
    const { input, box } = await create("META");
    expect(box.warehouseIds).toEqual([]);
    expect(
      (
        await db.query(
          "SELECT shipping.box_available_at($1,1,false) AS available",
          [box.id],
        )
      ).rows[0].available,
    ).toBe(false);
    await availability([1], [box.id]);
    await repo.saveBox(
      {
        ...input,
        id: box.id,
        expectedRevision: 1,
        name: "Renamed",
        commandId: randomUUID(),
      },
      actor,
      now,
    );
    expect(
      (await repo.overview()).boxes.find((b) => b.id === box.id)?.warehouseIds,
    ).toEqual([1]);
    expect(
      (
        await db.query(
          "SELECT * FROM shipping.box_warehouse_stock WHERE box_id=$1",
          [box.id],
        )
      ).rows,
    ).toEqual([]);
  });
  it("a warehouse edit preserves legacy behavior everywhere else", async () => {
    expect(
      (
        await db.query(
          "SELECT shipping.box_available_at(1,2,false) AS available",
        )
      ).rows[0].available,
    ).toBe(true);
    await availability([1], [1], false);
    expect(
      (
        await db.query(
          "SELECT shipping.box_available_at(1,1,false) AS available",
        )
      ).rows[0].available,
    ).toBe(false);
    expect(
      (
        await db.query(
          "SELECT shipping.box_available_at(1,2,false) AS available",
        )
      ).rows[0].available,
    ).toBe(true);
    expect(
      (
        await db.query(
          "SELECT availability_reviewed FROM shipping.box_catalog WHERE id=1",
        )
      ).rows[0].availability_reviewed,
    ).toBe(false);
  });
  it("bulk availability is atomic, revision guarded and idempotent", async () => {
    const { box } = await create("BULK");
    const input = {
      commandId: randomUUID(),
      warehouses: await warehouseTargets([1, 2]),
      boxIds: [box.id],
      available: true,
    };
    const outcomes = await Promise.allSettled([
      repo.saveAvailability(input, actor, now),
      repo.saveAvailability({ ...input, commandId: randomUUID() }, actor, now),
    ]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const winner = outcomes[0].status === "fulfilled";
    if (winner)
      expect(await repo.saveAvailability(input, actor, now)).toMatchObject({
        changed: 2,
      });
    await expect(
      repo.saveAvailability(
        { ...input, commandId: randomUUID(), available: false },
        actor,
        now,
      ),
    ).rejects.toMatchObject({ code: "SHIPPING_CONFIG_CHANGED" });
    expect(
      (await repo.overview()).boxes.find((b) => b.id === box.id)?.warehouseIds,
    ).toEqual([1, 2]);
  });
  it("adding from a suite copies only the reviewed snapshot", async () => {
    const first = await create("SNAPSHOT-A"),
      second = await create("SNAPSHOT-B");
    const suite = await createSuite("Snapshot suite", [first.box.id]);
    const command = {
      commandId: randomUUID(),
      warehouses: await warehouseTargets([1]),
      boxIds: [first.box.id],
      available: true,
      sourceSuite: { id: suite.id, revision: 1 },
    };
    await repo.saveAvailability(command, actor, now);
    await shared.saveSuite(
      {
        id: suite.id,
        name: suite.name,
        expectedRevision: 1,
        boxIds: [first.box.id, second.box.id],
        commandId: randomUUID(),
      },
      actor,
      now,
    );
    expect(
      (await repo.overview()).boxes.find((b) => b.id === second.box.id)
        ?.warehouseIds,
    ).toEqual([]);
    await expect(
      repo.saveAvailability(
        {
          ...command,
          commandId: randomUUID(),
          warehouses: await warehouseTargets([2]),
        },
        actor,
        now,
      ),
    ).rejects.toMatchObject({ code: "SHIPPING_CONFIG_CHANGED" });
  });
  it("bulk branding changes no memberships or availability and rejects any stale target", async () => {
    const a = await create("BRAND-A"),
      b = await create("BRAND-B");
    await availability([2], [a.box.id, b.box.id]);
    const suite = await createSuite("Brand suite", [a.box.id, b.box.id]);
    const input = {
      commandId: randomUUID(),
      boxes: [
        { id: a.box.id, revision: 1 },
        { id: b.box.id, revision: 1 },
      ],
      branding: "branded" as const,
    };
    expect(await repo.bulkBranding(input, actor, now)).toMatchObject({
      changed: 2,
    });
    expect(await repo.bulkBranding(input, actor, now)).toMatchObject({
      changed: 2,
    });
    await expect(
      repo.bulkBranding(
        { ...input, commandId: randomUUID(), branding: "unbranded" },
        actor,
        now,
      ),
    ).rejects.toMatchObject({ code: "SHIPPING_CONFIG_CHANGED" });
    const data = await repo.overview();
    expect(data.suites.find((s) => s.id === suite.id)?.boxIds).toEqual([
      a.box.id,
      b.box.id,
    ]);
    expect(data.boxes.find((box) => box.id === a.box.id)).toMatchObject({
      branding: "branded",
      warehouseIds: [2],
    });
  });
  it("program bulk assignment preserves exceptions, other channels, and physical availability", async () => {
    const a = await create("POLICY-A"),
      b = await create("POLICY-B");
    await availability([1, 2], [a.box.id, b.box.id]);
    const first = await createSuite("Program default", [a.box.id]),
      second = await createSuite("Program exception", [b.box.id]);
    for (const channelId of [21, 22])
      await repo.savePolicy(
        {
          commandId: randomUUID(),
          channelId,
          expectedRevision: 0,
          defaultSuiteId: first.id,
          requirement: "unbranded",
          overrides:
            channelId === 21 ? [{ warehouseId: 1, suiteId: second.id }] : [],
        },
        actor,
        now,
      );
    const before = (await repo.overview()).boxes;
    expect(
      await repo.assignWarehouseSuites(
        {
          commandId: randomUUID(),
          channelId: 21,
          expectedRevision: 1,
          warehouseIds: [1, 2],
          suiteId: first.id,
          replaceExisting: false,
        },
        actor,
        now,
      ),
    ).toMatchObject({ changed: 1, skipped: 1 });
    expect((await repo.resolve(21, 1))?.suiteId).toBe(second.id);
    expect((await repo.resolve(22, 1))?.source).toBe("default");
    await repo.assignWarehouseSuites(
      {
        commandId: randomUUID(),
        channelId: 21,
        expectedRevision: 2,
        warehouseIds: [1],
        suiteId: null,
        replaceExisting: true,
      },
      actor,
      now,
    );
    expect((await repo.resolve(21, 1))?.source).toBe("default");
    expect((await repo.overview()).boxes).toEqual(before);
    await expect(
      repo.bulkBranding(
        {
          commandId: randomUUID(),
          boxes: [
            { id: a.box.id, revision: 1 },
            { id: b.box.id, revision: 1 },
          ],
          branding: "branded",
        },
        actor,
        now,
      ),
    ).rejects.toMatchObject({ code: "SHIPPING_PACKAGING_POLICY_CONFLICT" });
    expect((await repo.overview()).boxes).toEqual(before);
  });
  it("audit insertion failure rolls back availability and revision changes", async () => {
    const { box } = await create("ROLLBACK");
    const targets = await warehouseTargets([1, 2]);
    await db.query(
      "CREATE FUNCTION shipping.reject_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST_AUDIT_FAILED'; END $$; CREATE TRIGGER reject_test_audit BEFORE INSERT ON shipping.configuration_commands FOR EACH ROW EXECUTE FUNCTION shipping.reject_test_audit()",
    );
    try {
      await expect(
        repo.saveAvailability(
          {
            commandId: randomUUID(),
            warehouses: targets,
            boxIds: [box.id],
            available: true,
          },
          actor,
          now,
        ),
      ).rejects.toThrow("TEST_AUDIT_FAILED");
    } finally {
      await db.query(
        "DROP TRIGGER reject_test_audit ON shipping.configuration_commands; DROP FUNCTION shipping.reject_test_audit()",
      );
    }
    expect(await warehouseTargets([1, 2])).toEqual(targets);
    expect(
      (await repo.overview()).boxes.find((b) => b.id === box.id)?.warehouseIds,
    ).toEqual([]);
  });
  it("initializes different suites at two warehouses atomically without a global assignment shortcut", async () => {
    await db.query(
      "INSERT INTO channels.channels VALUES(23,'New program','internal','manual','active',NULL);INSERT INTO channels.channel_warehouse_assignments VALUES(23,1,true),(23,2,true)",
    );
    const a = await create("LOCAL-A"),
      b = await create("LOCAL-B");
    await availability([1], [a.box.id]);
    await availability([2], [b.box.id]);
    const first = await createSuite("Local first", [a.box.id]),
      second = await createSuite("Local second", [b.box.id]);
    const input = {
      commandId: randomUUID(),
      channelId: 23,
      expectedRevision: 0,
      warehouseIds: [2],
      suiteId: second.id,
      replaceExisting: false,
      initialPolicy: {
        defaultSuiteId: first.id,
        requirement: "unbranded" as const,
      },
    };
    await repo.assignWarehouseSuites(input, actor, now);
    expect((await repo.resolve(23, 1))?.suiteId).toBe(first.id);
    expect((await repo.resolve(23, 2))?.suiteId).toBe(second.id);
    expect(
      (await repo.overview()).boxes.find((box) => box.id === a.box.id)
        ?.warehouseIds,
    ).toEqual([1]);
    expect(await repo.assignWarehouseSuites(input, actor, now)).toMatchObject({
      changed: 1,
    });
    await db.query(
      "DELETE FROM channels.channel_warehouse_assignments WHERE channel_id=23",
    );
  });
  it("updates 100 warehouses without touching channel routing or unselected warehouses", async () => {
    await db.query(
      "INSERT INTO warehouse.warehouses SELECT n,'Warehouse '||n FROM generate_series(100,199) n",
    );
    const { box } = await create("HUNDRED");
    const ids = Array.from({ length: 100 }, (_, i) => i + 100);
    expect(await availability(ids, [box.id])).toMatchObject({ changed: 100 });
    expect(
      (await repo.overview()).boxes.find((b) => b.id === box.id)?.warehouseIds,
    ).toEqual(ids);
    expect(
      (await db.query("SELECT * FROM channels.channel_warehouse_assignments"))
        .rows,
    ).toEqual([]);
  });
});
