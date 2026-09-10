import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ChannelPackagingRepository } from "../../infrastructure/channel-packaging.repository";
import { SharedShippingConfigurationRepository } from "../../infrastructure/shared-configuration.repository";
import { SHARED_SHIPPING_LEGACY_FIXTURE_SQL } from "./fixtures/shared-shipping-legacy";
import type {
  SaveCatalogBox,
  SaveChannelPackaging,
} from "@shared/shipping/packaging-policy";
import { BasicDropshipCartonizationProvider } from "../../../dropship/infrastructure/dropship-basic-cartonization.provider";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";
import { confirmParcel } from "../../application/packing.service";

const enabled =
  Boolean(process.env.ECHELON_TEST_DATABASE_URL) &&
  process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
describe.skipIf(!enabled)(
  "warehouse and actual-channel packaging PostgreSQL",
  () => {
    const database = `packaging_policy_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    let admin: Pool;
    let db: Pool;
    let repo: ChannelPackagingRepository;
    let shared: SharedShippingConfigurationRepository;
    const now = new Date("2026-09-09T12:00:00Z");
    let whiteId: number;
    let graphicId: number;
    let whiteSuite: number;
    let graphicSuite: number;
    const policy = (
      channelId: number,
      suiteId: number,
      expectedRevision = 0,
    ): SaveChannelPackaging => ({
      channelId,
      defaultSuiteId: suiteId,
      requirement: channelId === 11 ? "unbranded" : "any",
      overrides: [],
      expectedRevision,
      commandId: randomUUID(),
    });
    const box = (
      code: string,
      branding: SaveCatalogBox["branding"],
      _warehouseIds: number[],
    ): SaveCatalogBox => ({
      code,
      name: code,
      branding,
      kind: "box",
      lengthMm: 400,
      widthMm: 300,
      heightMm: 200,
      outerLengthMm: 410,
      outerWidthMm: 310,
      outerHeightMm: 210,
      tareWeightGrams: 50,
      maxWeightGrams: null,
      costCents: 32,
      fillFactorBps: 10000,
      isActive: true,
      expectedRevision: 0,
      commandId: randomUUID(),
    });
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
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        for (const name of [
          "238_shared_packaging_and_program_charges.sql",
          "239_packaging_suite_lifecycle.sql",
          "241_channel_packaging_policies.sql",
          "242_warehouse_packaging_availability.sql",
        ])
          await client.query(readFileSync(resolve("migrations", name), "utf8"));
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
      await db.query(`INSERT INTO channels.channels VALUES(11,'Dropship OMS','internal','manual','active',NULL),(12,'Main store','internal','shopify','active',NULL),(13,'Second Shopify store','internal','shopify','active',NULL);
      INSERT INTO channels.channel_warehouse_assignments VALUES(11,1,true),(11,2,true),(12,1,true),(12,2,true);`);
      whiteId = (
        await repo.saveBox(box("WHITE", "unbranded", [1, 2]), "admin", now)
      ).box.id;
      graphicId = (
        await repo.saveBox(box("GRAPHIC", "branded", [1, 2]), "admin", now)
      ).box.id;
      await repo.saveAvailability(
        {
          commandId: randomUUID(),
          warehouses: [
            { id: 1, revision: 0 },
            { id: 2, revision: 0 },
          ],
          boxIds: [whiteId, graphicId],
          available: true,
        },
        "admin",
        now,
      );
      whiteSuite = (
        await shared.saveSuite(
          {
            name: "White suite",
            boxIds: [whiteId],
            expectedRevision: 0,
            commandId: randomUUID(),
          },
          "admin",
          now,
        )
      ).id;
      graphicSuite = (
        await shared.saveSuite(
          {
            name: "Graphic suite",
            boxIds: [graphicId],
            expectedRevision: 0,
            commandId: randomUUID(),
          },
          "admin",
          now,
        )
      ).id;
    });
    afterAll(async () => {
      await db?.end();
      if (admin) {
        await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
        await admin.end();
      }
    });
    it("does not manufacture reviewed availability, branding or policies on migration", async () => {
      const original = (
        await db.query(
          "SELECT branding,availability_reviewed FROM shipping.box_catalog WHERE id=1",
        )
      ).rows[0];
      expect(original).toEqual({
        branding: "unclassified",
        availability_reviewed: false,
      });
      expect(await repo.resolve(13, 1)).toBeNull();
    });
    it("both warehouses use different suites for Dropship and the main Shopify store", async () => {
      await repo.savePolicy(policy(11, whiteSuite), "admin", now);
      await repo.savePolicy(policy(12, graphicSuite), "admin", now);
      for (const warehouseId of [1, 2]) {
        expect(
          (await shared.loadPackaging("dropship", warehouseId, 11)).boxes.map(
            (b) => b.id,
          ),
        ).toEqual([whiteId]);
        expect(
          (await shared.loadPackaging("shopify", warehouseId, 12)).boxes.map(
            (b) => b.id,
          ),
        ).toEqual([graphicId]);
      }
    });
    it("distinguishes two Shopify stores rather than using their shared provider label", async () => {
      await repo.savePolicy(policy(13, whiteSuite), "admin", now);
      expect((await shared.loadPackaging("shopify", 1, 13)).suiteId).toBe(
        whiteSuite,
      );
      expect((await shared.loadPackaging("shopify", 1, 12)).suiteId).toBe(
        graphicSuite,
      );
    });
    it("threads the OMS channel into the real Dropship cartonization provider", async () => {
      const result = await new BasicDropshipCartonizationProvider(db).cartonize(
        {
          vendorId: 1,
          storeConnectionId: 1,
          warehouseId: 2,
          destination: { country: "US", region: "PA", postalCode: "16046" },
          items: [{ productVariantId: 66, quantity: 1 }],
          quotedAt: now,
        },
      );
      expect(result.packaging).toMatchObject({
        channelId: 11,
        suiteId: whiteSuite,
        warehouseId: 2,
      });
      expect(result.packages.length).toBeGreaterThan(0);
      expect(result.packages.every((p) => p.boxId === whiteId)).toBe(true);
    });
    it("rejects branded assignment, suite contamination, and archive of an assigned suite", async () => {
      await expect(
        repo.savePolicy(policy(11, graphicSuite, 1), "admin", now),
      ).rejects.toMatchObject({ code: "SHIPPING_SUITE_BRANDING_CONFLICT" });
      await expect(
        shared.saveSuite(
          {
            id: whiteSuite,
            name: "White suite",
            boxIds: [whiteId, graphicId],
            expectedRevision: 1,
            commandId: randomUUID(),
          },
          "admin",
          now,
        ),
      ).rejects.toMatchObject({ code: "SHIPPING_PACKAGING_POLICY_CONFLICT" });
      await expect(
        shared.changeSuiteStatus(
          {
            id: whiteSuite,
            expectedRevision: 1,
            archived: true,
            commandId: randomUUID(),
          },
          "admin",
          now,
        ),
      ).rejects.toMatchObject({ code: "SHIPPING_PACKAGING_POLICY_CONFLICT" });
      expect((await repo.resolve(11, 1))?.suiteRevision).toBe(1);
    });
    it("serializes stale competing changes and replays the identical command", async () => {
      const first = policy(13, whiteSuite, 1);
      const second = policy(13, graphicSuite, 1);
      const results = await Promise.allSettled([
        repo.savePolicy(first, "admin", now),
        repo.savePolicy(second, "admin", now),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const winner = results[0].status === "fulfilled" ? first : second;
      expect((await repo.savePolicy(winner, "admin", now)).revision).toBe(2);
      await expect(
        repo.savePolicy({ ...winner, requirement: "unbranded" }, "admin", now),
      ).rejects.toMatchObject({ code: "SHIPPING_COMMAND_REUSED" });
    });
    it("explicitly empty availability is empty, not global; invalid override cannot fall back", async () => {
      const unavailableId = (
        await repo.saveBox(box("UNAVAILABLE", "unbranded", []), "admin", now)
      ).box.id;
      const suite = await shared.saveSuite(
        {
          name: "Unavailable suite",
          boxIds: [unavailableId],
          expectedRevision: 0,
          commandId: randomUUID(),
        },
        "admin",
        now,
      );
      await expect(
        repo.savePolicy(
          {
            ...policy(11, whiteSuite, 1),
            overrides: [{ warehouseId: 2, suiteId: suite.id }],
          },
          "admin",
          now,
        ),
      ).rejects.toMatchObject({ code: "SHIPPING_SUITE_AVAILABILITY_REQUIRED" });
    });
    it("audits box edits and rejects stale revisions without rewriting any data", async () => {
      const input = box("AUDIT", "unbranded", [1]);
      const result = await repo.saveBox(input, "operator-1", now);
      expect(await repo.saveBox(input, "operator-1", now)).toEqual(result);
      const id = result.box.id;
      await expect(
        repo.saveBox(
          { ...input, id, expectedRevision: 0, commandId: randomUUID() },
          "operator-1",
          now,
        ),
      ).rejects.toMatchObject({ code: "SHIPPING_CONFIG_CHANGED" });
      const audit = (
        await db.query(
          "SELECT actor_id,before_state,after_state FROM shipping.configuration_commands WHERE resource_key=$1",
          [`box:${id}`],
        )
      ).rows;
      expect(audit).toHaveLength(1);
      expect(audit[0].actor_id).toBe("operator-1");
    });
    it("overview reports actual identities and independently configured prices", async () => {
      const data = await repo.overview();
      expect(data.channels.find((c) => c.id === 11)?.legacyProfile).toBe(
        "dropship",
      );
      expect(
        data.policies.filter((p) => [11, 12].includes(p.channelId)),
      ).toHaveLength(2);
      expect(
        data.warehouseAssignments.filter((a) => a.channelId === 11),
      ).toHaveLength(2);
    });
    it("requires coverage for both enabled warehouses, supports atomic exceptions and reset to default", async () => {
      await db.query(
        "INSERT INTO channels.channels VALUES(20,'Coverage test','internal','manual','active',NULL); INSERT INTO channels.channel_warehouse_assignments VALUES(20,1,true),(20,2,true)",
      );
      const localBox = box("WEST-ONLY", "unbranded", [2]);
      const localId = (await repo.saveBox(localBox, "admin", now)).box.id;
      await repo.saveAvailability(
        {
          commandId: randomUUID(),
          warehouses: [
            {
              id: 2,
              revision: (await repo.overview()).warehouses.find(
                (w) => w.id === 2,
              )!.packagingRevision,
            },
          ],
          boxIds: [localId],
          available: true,
        },
        "admin",
        now,
      );
      const localSuite = await shared.saveSuite(
        {
          name: "West only",
          boxIds: [localId],
          expectedRevision: 0,
          commandId: randomUUID(),
        },
        "admin",
        now,
      );
      await expect(
        repo.savePolicy(policy(20, localSuite.id), "admin", now),
      ).rejects.toMatchObject({ code: "SHIPPING_SUITE_STRANDS_WAREHOUSE" });
      await repo.savePolicy(
        {
          ...policy(20, localSuite.id),
          overrides: [{ warehouseId: 1, suiteId: whiteSuite }],
        },
        "admin",
        now,
      );
      expect((await repo.resolve(20, 1))?.source).toBe("warehouse");
      expect((await repo.resolve(20, 2))?.boxes.map((b) => b.id)).toEqual([
        localId,
      ]);
      await repo.savePolicy(policy(20, whiteSuite, 1), "admin", now);
      expect((await repo.resolve(20, 1))?.source).toBe("default");
      await repo.savePolicy(
        {
          ...policy(20, whiteSuite, 2),
          overrides: [{ warehouseId: 2, suiteId: localSuite.id }],
        },
        "admin",
        now,
      );
      const before = await repo.resolve(20, 2);
      await repo.saveAvailability(
        {
          commandId: randomUUID(),
          warehouses: [
            {
              id: 2,
              revision: (await repo.overview()).warehouses.find(
                (w) => w.id === 2,
              )!.packagingRevision,
            },
          ],
          boxIds: [localId],
          available: false,
        },
        "admin",
        now,
      );
      await expect(repo.resolve(20, 2)).rejects.toMatchObject({
        code: "SHIPPING_SUITE_EMPTY_AT_WAREHOUSE",
      });
      expect(before?.boxes.map((b) => b.id)).toEqual([localId]); // Existing evidence is not rewritten.
    });
    it("rejects changing an assigned white-label box to branded", async () => {
      await expect(
        repo.saveBox(
          {
            ...box("WHITE", "branded", [1, 2]),
            id: whiteId,
            expectedRevision: 1,
          },
          "admin",
          now,
        ),
      ).rejects.toMatchObject({ code: "SHIPPING_PACKAGING_POLICY_CONFLICT" });
      expect((await repo.resolve(11, 1))?.boxes.map((b) => b.id)).toEqual([
        whiteId,
      ]);
    });
    it("confirms concurrent parcels atomically, journals once, and rolls back actuals on audit failure", async () => {
      await db.query(`CREATE SCHEMA wms; CREATE TABLE wms.orders(id integer PRIMARY KEY,warehouse_id integer,channel_id integer);
      INSERT INTO wms.orders VALUES(900,2,11);
      ALTER TABLE shipping.pack_plans ADD COLUMN wms_order_id integer,ADD COLUMN shipment_request_id bigint,ADD COLUMN status text DEFAULT 'active',ADD COLUMN engine_version text DEFAULT 'test',ADD COLUMN input_hash text,ADD COLUMN warnings jsonb,ADD COLUMN created_at timestamptz DEFAULT now(),ADD COLUMN updated_at timestamptz DEFAULT now();
      ALTER TABLE shipping.pack_plan_parcels ADD COLUMN pack_plan_id bigint,ADD COLUMN parcel_sequence integer,ADD COLUMN box_id integer,ADD COLUMN sioc_product_variant_id integer,
        ADD COLUMN est_weight_grams integer DEFAULT 500,ADD COLUMN billable_weight_grams integer DEFAULT 500,ADD COLUMN length_mm integer DEFAULT 100,ADD COLUMN width_mm integer DEFAULT 100,ADD COLUMN height_mm integer DEFAULT 100,ADD COLUMN placements jsonb DEFAULT '[]',
        ADD COLUMN actual_box_id integer,ADD COLUMN actual_weight_grams integer,ADD COLUMN packed_at timestamptz,ADD COLUMN packed_by varchar(120),ADD COLUMN created_at timestamptz DEFAULT now();`);
      const evidence = await repo.resolve(11, 2);
      await db.query(
        "INSERT INTO shipping.pack_plans(id,wms_order_id,packaging_snapshot) VALUES(900,900,$1),(901,900,$1)",
        [JSON.stringify(evidence)],
      );
      await db.query(
        "INSERT INTO shipping.pack_plan_parcels(id,pack_plan_id,parcel_sequence,box_id) VALUES(900,900,1,$1),(901,900,2,$1),(902,901,1,$1)",
        [whiteId],
      );
      const database = drizzle(db, { schema });
      const confirm = (parcelId: number, planId = 900, packedBy = "packer") =>
        confirmParcel(
          {
            planId,
            parcelId,
            actualBoxId: whiteId,
            actualWeightGrams: 500,
            packedBy,
          },
          () => now,
          database,
        );
      const results = await Promise.all([confirm(900), confirm(901)]);
      expect(results.every((r) => r.ok)).toBe(true);
      expect(
        results.some(
          (r) => r.ok && r.allConfirmed && r.planStatus === "packed",
        ),
      ).toBe(true);
      await confirm(900);
      expect(
        (
          await db.query(
            "SELECT count(*)::int AS count FROM shipping.packaging_confirmation_events WHERE plan_id=900",
          )
        ).rows[0].count,
      ).toBe(2);
      await expect(
        db.query(
          "UPDATE shipping.packaging_confirmation_events SET actor_id='changed' WHERE plan_id=900",
        ),
      ).rejects.toThrow();
      await db.query(`CREATE FUNCTION shipping.reject_test_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.actor_id='reject-audit' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_test_confirmation BEFORE INSERT ON shipping.packaging_confirmation_events FOR EACH ROW EXECUTE FUNCTION shipping.reject_test_confirmation()`);
      await expect(confirm(902, 901, "reject-audit")).rejects.toThrow(
        /audit unavailable/,
      );
      expect(
        (
          await db.query(
            "SELECT packed_at FROM shipping.pack_plan_parcels WHERE id=902",
          )
        ).rows[0].packed_at,
      ).toBeNull();
      expect(
        (await db.query("SELECT status FROM shipping.pack_plans WHERE id=901"))
          .rows[0].status,
      ).toBe("active");
    });
  },
);
