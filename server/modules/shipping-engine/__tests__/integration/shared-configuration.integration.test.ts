import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SharedShippingConfigurationRepository } from "../../infrastructure/shared-configuration.repository";
import { applyProgramCharges } from "../../domain/program-charges";
import { NO_PROGRAM_CHARGES } from "@shared/shipping/configuration";
import { BasicDropshipCartonizationProvider } from "../../../dropship/infrastructure/dropship-basic-cartonization.provider";
import { SHARED_SHIPPING_LEGACY_FIXTURE_SQL } from "./fixtures/shared-shipping-legacy";

const enabled =
  Boolean(process.env.ECHELON_TEST_DATABASE_URL) &&
  process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
describe.skipIf(!enabled)(
  "shared packaging and charges PostgreSQL guarantees",
  () => {
    const database = `shipping_config_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    let admin: Pool;
    let db: Pool;
    let repo: SharedShippingConfigurationRepository;
    const now = new Date("2026-09-09T12:00:00Z");
    beforeAll(async () => {
      admin = new Pool({
        connectionString: process.env.ECHELON_TEST_DATABASE_URL,
      });
      await admin.query(`CREATE DATABASE "${database}"`);
      const url = new URL(process.env.ECHELON_TEST_DATABASE_URL!);
      url.pathname = `/${database}`;
      db = new Pool({ connectionString: url.toString() });
      repo = new SharedShippingConfigurationRepository(db);
      await db.query(SHARED_SHIPPING_LEGACY_FIXTURE_SQL);
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        for (const name of ["238_shared_packaging_and_program_charges.sql"]) {
          await client.query(readFileSync(resolve("migrations", name), "utf8"));
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    });
    afterAll(async () => {
      await db?.end();
      if (admin) {
        await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
        await admin.end();
      }
    });
    it("migrates distinct catalog identities and preserves each channel suite", async () => {
      const config = await repo.listPackaging();
      expect(config.boxes).toHaveLength(2);
      const dropship = await repo.loadPackaging("dropship", 1);
      const retail = await repo.loadPackaging("shopify", 1);
      expect(dropship.boxes.map((b) => b.code)).toEqual([
        "migrated-dropship-7",
      ]);
      expect(dropship.boxes[0].fillFactorBps).toBe(10000);
      expect(retail.boxes.map((b) => b.code)).toEqual(["SHARED"]);
      expect(
        (await db.query("SELECT * FROM shipping.channel_packing_preferences"))
          .rows[0],
      ).toMatchObject({
        channel: "dropship",
        product_variant_id: 66,
        preferred_box_id: dropship.boxes[0].id,
        legacy_carrier: "USPS",
        legacy_service: "Ground Advantage",
      });
    });
    it("preserves fees while leaving retail prices untouched", async () => {
      const policy = await repo.loadCharges(1, now);
      expect(
        applyProgramCharges(800, policy.charges, policy.revision).totalCents,
      ).toBe(824);
      const retail = await repo.loadCharges(2, now);
      expect(
        applyProgramCharges(800, retail.charges, retail.revision).totalCents,
      ).toBe(800);
      await expect(
        repo.loadCharges(1, new Date("2025-01-01")),
      ).rejects.toMatchObject({ code: "SHIPPING_CHARGE_POLICY_REQUIRED" });
    });
    it.each([1, 2, 5])(
      "packs quantity %i from the shared suite and canonical catalog facts",
      async (quantity) => {
        const result = await new BasicDropshipCartonizationProvider(
          db,
        ).cartonize({
          vendorId: 1,
          storeConnectionId: 1,
          warehouseId: 1,
          quotedAt: now,
          destination: { country: "US", region: "PA", postalCode: "16046" },
          items: [{ productVariantId: 66, quantity }],
        });
        expect(result.packaging?.suiteRevision).toBe(1);
        expect(
          result.packages.reduce((sum, parcel) => sum + parcel.quantity, 0),
        ).toBe(quantity);
        expect(
          result.packages.every(
            (parcel) => parcel.boxCode === "migrated-dropship-7",
          ),
        ).toBe(true);
        expect(
          result.packages.reduce((sum, parcel) => sum + parcel.weightGrams, 0),
        ).toBe(590 * quantity + 45 * result.packages.length);
        expect(result.packagingWarnings).toEqual([]);
      },
    );
    it("atomically rejects concurrent stale suite edits and retains prior membership", async () => {
      const suite = (await repo.listPackaging()).suites.find(
        (s) => s.name === "Dropship packaging",
      )!;
      const input = {
        id: suite.id,
        name: suite.name,
        boxIds: suite.boxIds,
        expectedRevision: suite.revision,
      };
      const results = await Promise.allSettled([
        repo.saveSuite({ ...input, commandId: randomUUID() }, "admin1", now),
        repo.saveSuite({ ...input, commandId: randomUUID() }, "admin2", now),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      expect(
        (
          await db.query(
            "SELECT * FROM shipping.box_suite_members WHERE suite_id=$1 AND revision=1",
            [suite.id],
          )
        ).rows,
      ).toHaveLength(1);
    });
    it("replays commands and rejects reuse with different input", async () => {
      const input = {
        name: "Reusable",
        boxIds: [1],
        expectedRevision: 0,
        commandId: randomUUID(),
      };
      const first = await repo.saveSuite(input, "admin", now);
      expect(await repo.saveSuite(input, "admin", now)).toEqual(first);
      expect(await repo.history(`suite:${first.id}`)).toMatchObject([
        { actorId: "admin", before: null, after: first },
      ]);
      await expect(
        repo.saveSuite({ ...input, name: "Changed" }, "admin", now),
      ).rejects.toMatchObject({ code: "SHIPPING_COMMAND_REUSED" });
      await expect(
        db.query(
          "DELETE FROM shipping.configuration_commands WHERE command_id=$1",
          [input.commandId],
        ),
      ).rejects.toThrow("IMMUTABLE");
    });
    it("resolves exact warehouse overrides and never widens an empty suite", async () => {
      const suite = (await repo.listPackaging()).suites.find(
        (s) => s.name === "Reusable",
      )!;
      await repo.saveAssignment(
        {
          channel: "dropship",
          warehouseId: 2,
          suiteId: suite.id,
          expectedRevision: 0,
          commandId: randomUUID(),
        },
        "admin",
        now,
      );
      expect((await repo.loadPackaging("dropship", 2)).boxes[0].code).toBe(
        "SHARED",
      );
      await db.query(
        "INSERT INTO shipping.box_warehouse_stock VALUES(1,1,true)",
      );
      await expect(repo.loadPackaging("dropship", 2)).rejects.toMatchObject({
        code: "SHIPPING_SUITE_EMPTY_AT_WAREHOUSE",
      });
      expect((await repo.loadPackaging("dropship", 1)).boxes[0].code).toBe(
        "migrated-dropship-7",
      );
    });
    it("saves selected service and exposes updated shared settings", async () => {
      await repo.saveService(
        {
          channel: "dropship",
          serviceLevelId: 2,
          expectedRevision: 1,
          commandId: randomUUID(),
        },
        "admin",
        now,
      );
      expect(await repo.loadService("dropship")).toEqual({
        serviceLevelCode: "expedited",
        revision: 2,
      });
      await repo.saveDropshipProgram(
        {
          warehouseId: 2,
          rateBookId: 2,
          expectedProgramId: null,
          commandId: randomUUID(),
        },
        "admin",
        now,
      );
      const config = await repo.dropshipConfig(null);
      expect(config.selectedService).toEqual({ id: 2, revision: 2 });
      expect(config.assignments).toContainEqual({
        warehouseId: 2,
        rateBookId: 2,
      });
    });
    it("rejects suite edits that strand an assigned warehouse", async () => {
      const suite = (await repo.listPackaging()).suites.find(
        (s) => s.name === "Reusable",
      )!;
      await expect(
        repo.saveSuite(
          {
            id: suite.id,
            name: suite.name,
            boxIds: [1],
            expectedRevision: suite.revision,
            commandId: randomUUID(),
          },
          "admin",
          now,
        ),
      ).rejects.toMatchObject({ code: "SHIPPING_SUITE_STRANDS_WAREHOUSE" });
      expect(
        (await repo.listPackaging()).suites.find((s) => s.id === suite.id)
          ?.revision,
      ).toBe(suite.revision);
    });
    it('keeps a replacement suite authoritative over migrated box preferences',async () => {
      await db.query("INSERT INTO warehouse.warehouses VALUES(3,'East')");
      await db.query('INSERT INTO shipping.box_warehouse_stock VALUES(1,3,true)');
      const suite = (await repo.listPackaging()).suites.find((row) => row.name === 'Reusable')!;
      await repo.saveAssignment({ channel: 'dropship',warehouseId: 3,suiteId: suite.id,expectedRevision: 0,commandId: randomUUID() },'admin',now);
      const result = await new BasicDropshipCartonizationProvider(db).cartonize({
        vendorId: 1,storeConnectionId: 1,warehouseId: 3,quotedAt: now,
        destination: { country: 'US',region: 'PA',postalCode: '16046' },items: [{ productVariantId: 66,quantity: 1 }],
      });
      expect(result.packages[0].boxCode).toBe('SHARED');
      expect(result.warnings).toContain('An unavailable legacy box preference was ignored; the assigned suite supplied the packaging.');
      expect(result.packagingWarnings).toEqual([]);
    });
    it("rejects partial or undersized outer dimensions", async () => {
      await expect(
        db.query(
          "UPDATE shipping.box_catalog SET outer_length_mm=210 WHERE id=1",
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await db.query(
        "UPDATE shipping.box_catalog SET outer_length_mm=210,outer_width_mm=160,outer_height_mm=110 WHERE id=1",
      );
      expect((await repo.loadPackaging("shopify", 1)).boxes[0]).toMatchObject({
        lengthMm: 200,
        outerLengthMm: 210,
      });
    });
    it("closes charge revisions atomically, preserving historical quotes", async () => {
      await repo.saveCharges(
        1,
        {
          expectedRevision: 1,
          commandId: randomUUID(),
          charges: NO_PROGRAM_CHARGES,
        },
        "admin",
        now,
      );
      expect((await repo.loadCharges(1, now)).revision).toBe(2);
      const old = await repo.loadCharges(1, new Date("2026-09-08"));
      expect(
        applyProgramCharges(800, old.charges, old.revision).totalCents,
      ).toBe(824);
      await expect(
        repo.saveCharges(
          1,
          {
            expectedRevision: 1,
            commandId: randomUUID(),
            charges: NO_PROGRAM_CHARGES,
          },
          "admin",
          now,
        ),
      ).rejects.toMatchObject({ code: "SHIPPING_CONFIG_CHANGED" });
    });
    it("replaces a bounded charge window without creating overlapping prices", async () => {
      await db.query(
        `INSERT INTO shipping.rate_book_charge_revisions(rate_book_id,revision,charges,effective_from,effective_to,actor_id)
      VALUES(2,1,$1,'2026-01-01','2027-01-01','fixture')`,
        [JSON.stringify(NO_PROGRAM_CHARGES)],
      );
      await repo.saveCharges(
        2,
        {
          expectedRevision: 1,
          commandId: randomUUID(),
          charges: NO_PROGRAM_CHARGES,
        },
        "admin",
        now,
      );
      expect((await repo.loadCharges(2, now)).revision).toBe(2);
      expect((await repo.loadCharges(2, new Date("2026-09-08"))).revision).toBe(
        1,
      );
      await expect(
        db.query(
          "UPDATE shipping.rate_book_charge_revisions SET actor_id='changed' WHERE rate_book_id=2 AND revision=1",
        ),
      ).rejects.toThrow("SHIPPING_CHARGE_HISTORY_IMMUTABLE");
      await expect(repo.readChargeConfiguration(999)).rejects.toMatchObject({
        code: "SHIPPING_PROGRAM_UNAVAILABLE",
        status: 404,
      });
    });
  },
);
