import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { boxDimensionMmSchema, databaseMillimetersSchema } from "@shared/shipping/dimensions";
import { pool as defaultPool } from "../../../db";
import {
  boxBrandingSchema,
  channelPackagingPolicySchema,
  packagingPolicyOverviewSchema,
  type SaveCatalogBox,
  type SaveChannelPackaging,
  type ChannelPackagingPolicy,
  type PackagingPolicyOverview,
  type BulkBoxBranding,
  type WarehouseAvailability,
  type WarehouseSuiteAssignment,
  type PackagingBulkResult,
} from "@shared/shipping/packaging-policy";
import type { ChannelPackagingStore } from "../application/channel-packaging.service";
import type { CartonizeBox } from "../../cartonization/domain/cartonize";
import { resolvePackingFulfillmentChannel } from "../../cartonization/domain/fulfillment-channel";
import {
  assertSuiteBranding,
  eligiblePackagingBoxes,
  resolveChannelSuite,
} from "../domain/channel-packaging";
import { ShippingConfigurationError } from "../domain/configuration-error";
import { configurationCommand } from "./configuration-command";
import { planWarehouseSuiteAssignment } from "../domain/warehouse-suite-assignment";

const conflict = () =>
  new ShippingConfigurationError(
    "SHIPPING_CONFIG_CHANGED",
    "Configuration changed. Reload before saving.",
  );
const databaseBoxDimension = databaseMillimetersSchema.pipe(boxDimensionMmSchema);
const boxSchema = z.object({
  id: z.number().int().positive(),
  code: z.string(),
  name: z.string(),
  kind: z.enum(["box", "mailer", "envelope"]),
  lengthMm: databaseBoxDimension,
  widthMm: databaseBoxDimension,
  heightMm: databaseBoxDimension,
  outerLengthMm: databaseBoxDimension.nullable(),
  outerWidthMm: databaseBoxDimension.nullable(),
  outerHeightMm: databaseBoxDimension.nullable(),
  tareWeightGrams: z.number().int().nonnegative(),
  maxWeightGrams: z.number().int().positive().nullable(),
  costCents: z.number().int().nonnegative(),
  fillFactorBps: z.number().int().positive().max(10000),
  isActive: z.boolean(),
  branding: boxBrandingSchema,
  availabilityReviewed: z.boolean(),
  warehouseIds: z.array(z.number().int().positive()),
  configurationRevision: z.number().int().positive(),
});
type CatalogBox = z.infer<typeof boxSchema>;
const BOX_PROJECTION = `b.id,b.code,b.name,b.kind,b.length_mm AS "lengthMm",b.width_mm AS "widthMm",b.height_mm AS "heightMm",
  b.outer_length_mm AS "outerLengthMm",b.outer_width_mm AS "outerWidthMm",b.outer_height_mm AS "outerHeightMm",
  b.tare_weight_grams AS "tareWeightGrams",b.max_weight_grams AS "maxWeightGrams",b.cost_cents AS "costCents",
  b.fill_factor_bps AS "fillFactorBps",b.is_active AS "isActive",b.branding,true AS "availabilityReviewed",
  b.configuration_revision AS "configurationRevision",COALESCE((SELECT jsonb_agg(w.id ORDER BY w.id)
    FROM warehouse.warehouses w WHERE shipping.box_available_at(b.id,w.id,true)),'[]'::jsonb) AS "warehouseIds"`;
const POLICY_PROJECTION = `p.channel_id AS "channelId",p.revision,p.default_suite_id AS "defaultSuiteId",p.requirement,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('warehouseId',o.warehouse_id,'suiteId',o.suite_id) ORDER BY o.warehouse_id)
    FROM shipping.channel_packaging_overrides o WHERE o.channel_id=p.channel_id),'[]'::jsonb) AS overrides`;

export interface ResolvedChannelPackaging {
  channelId: number;
  warehouseId: number;
  suiteId: number;
  suiteRevision: number;
  assignmentRevision: number;
  requirement: ChannelPackagingPolicy["requirement"];
  source: "default" | "warehouse";
  boxes: CartonizeBox[];
}

export class ChannelPackagingRepository implements ChannelPackagingStore {
  constructor(private readonly pool: Pool = defaultPool) {}

  async overview(): Promise<PackagingPolicyOverview> {
    // A repeatable-read snapshot prevents the assignment UI mixing policy/box revisions.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const channels = await client.query(
        `SELECT id,name,provider,status,type,shipping_config FROM channels.channels ORDER BY name,id`,
      );
      const policies = await client.query(
        `SELECT ${POLICY_PROJECTION} FROM shipping.channel_packaging_policies p ORDER BY p.channel_id`,
      );
      const warehouses = await client.query(
        `SELECT w.id,w.name,COALESCE(r.revision,0) AS "packagingRevision" FROM warehouse.warehouses w
         LEFT JOIN shipping.warehouse_packaging_revisions r ON r.warehouse_id=w.id ORDER BY w.name,w.id`,
      );
      const boxes = await client.query(
        `SELECT ${BOX_PROJECTION} FROM shipping.box_catalog b ORDER BY b.code`,
      );
      const suites =
        await client.query(`SELECT s.id,s.name,s.current_revision AS revision,s.archived,
        COALESCE((SELECT jsonb_agg(m.box_id ORDER BY m.box_id) FROM shipping.box_suite_members m
          WHERE m.suite_id=s.id AND m.revision=s.current_revision),'[]'::jsonb) AS "boxIds" FROM shipping.box_suites s ORDER BY s.name`);
      const pricing =
        await client.query(`SELECT p.channel_id AS "channelId",r.origin_warehouse_id AS "warehouseId",b.name,p.purpose
        FROM shipping.channel_policies p JOIN shipping.channel_policy_routes r ON r.policy_id=p.id
        JOIN shipping.rate_books b ON b.id=r.rate_book_id WHERE p.status='active' ORDER BY p.channel_id,r.id`);
      const warehouseAssignments = await client.query(
        `SELECT channel_id AS "channelId",warehouse_id AS "warehouseId",enabled FROM channels.channel_warehouse_assignments`,
      );
      const result = packagingPolicyOverviewSchema.parse({
        channels: channels.rows.map((c) => ({
          id: c.id,
          name: c.name,
          provider: c.provider,
          status: c.status,
          legacyProfile: resolvePackingFulfillmentChannel({
            source: c.provider,
            channelName: c.name,
            channelType: c.type,
            channelProvider: c.provider,
            shippingConfig: c.shipping_config,
          }),
        })),
        policies: policies.rows,
        warehouses: warehouses.rows,
        boxes: boxes.rows,
        suites: suites.rows,
        pricing: pricing.rows,
        warehouseAssignments: warehouseAssignments.rows,
      });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async savePolicy(
    input: SaveChannelPackaging,
    actor: string,
    now: Date,
  ): Promise<ChannelPackagingPolicy> {
    return configurationCommand(
      this.pool,
      `channel-packaging:${input.channelId}`,
      input,
      actor,
      now,
      (client) => this.persistPolicy(client, input),
    );
  }

  private async persistPolicy(client: PoolClient, input: SaveChannelPackaging) {
    const current = (
      await client.query(
        `SELECT ${POLICY_PROJECTION} FROM shipping.channel_packaging_policies p WHERE p.channel_id=$1 FOR UPDATE`,
        [input.channelId],
      )
    ).rows[0];
    if ((current?.revision ?? 0) !== input.expectedRevision) throw conflict();
    const channel = (
      await client.query(
        "SELECT id FROM channels.channels WHERE id=$1 AND status='active' FOR SHARE",
        [input.channelId],
      )
    ).rows[0];
    if (!channel)
      throw new ShippingConfigurationError(
        "SHIPPING_CHANNEL_UNAVAILABLE",
        "Choose an active fulfillment channel.",
      );
    const warehouseIds = input.overrides.map((o) => o.warehouseId);
    const warehouses = await client.query(
      "SELECT id FROM warehouse.warehouses WHERE id=ANY($1::int[])",
      [warehouseIds],
    );
    if (warehouses.rows.length !== warehouseIds.length)
      throw new ShippingConfigurationError(
        "SHIPPING_WAREHOUSE_REQUIRED",
        "An assigned warehouse no longer exists.",
      );
    // Load each reusable suite once, even when hundreds of warehouses inherit it.
    const suiteBoxes = new Map<number, CatalogBox[]>();
    for (const suiteId of new Set([
      input.defaultSuiteId,
      ...input.overrides.map((o) => o.suiteId),
    ])) {
      const { boxes } = await this.readSuite(client, suiteId);
      suiteBoxes.set(suiteId, boxes);
      assertSuiteBranding(input.requirement, boxes);
      if (
        !boxes.some(
          (b) => b.isActive && b.availabilityReviewed && b.warehouseIds.length,
        )
      ) {
        throw new ShippingConfigurationError(
          "SHIPPING_SUITE_AVAILABILITY_REQUIRED",
          "Review available packaging in warehouse configuration before assigning this suite.",
        );
      }
    }
    // An explicit override must be usable. Never save it and silently use a default instead.
    for (const override of input.overrides) {
      const boxes = suiteBoxes.get(override.suiteId)!;
      if (
        !eligiblePackagingBoxes(boxes, override.warehouseId, input.requirement)
          .length
      )
        throw new ShippingConfigurationError(
          "SHIPPING_SUITE_EMPTY_AT_WAREHOUSE",
          "The selected suite has no reviewed, available boxes at this warehouse.",
        );
    }
    const after = channelPackagingPolicySchema.parse({
      channelId: input.channelId,
      revision: input.expectedRevision + 1,
      defaultSuiteId: input.defaultSuiteId,
      requirement: input.requirement,
      overrides: [...input.overrides].sort(
        (a, b) => a.warehouseId - b.warehouseId,
      ),
    });
    const enabledWarehouses = await client.query(
      "SELECT warehouse_id FROM channels.channel_warehouse_assignments WHERE channel_id=$1 AND enabled",
      [input.channelId],
    );
    for (const row of enabledWarehouses.rows) {
      const selection = resolveChannelSuite(after, row.warehouse_id);
      if (
        !eligiblePackagingBoxes(
          suiteBoxes.get(selection.suiteId)!,
          row.warehouse_id,
          input.requirement,
        ).length
      )
        throw new ShippingConfigurationError(
          "SHIPPING_SUITE_STRANDS_WAREHOUSE",
          `No reviewed packaging is available at enabled warehouse ${row.warehouse_id}. Review availability or set a warehouse override before saving.`,
        );
    }
    await client.query(
      `INSERT INTO shipping.channel_packaging_policies(channel_id,revision,default_suite_id,requirement) VALUES($1,$2,$3,$4)
        ON CONFLICT(channel_id) DO UPDATE SET revision=excluded.revision,default_suite_id=excluded.default_suite_id,requirement=excluded.requirement`,
      [
        after.channelId,
        after.revision,
        after.defaultSuiteId,
        after.requirement,
      ],
    );
    await client.query(
      "DELETE FROM shipping.channel_packaging_overrides WHERE channel_id=$1",
      [input.channelId],
    );
    await client.query(
      `INSERT INTO shipping.channel_packaging_overrides(channel_id,warehouse_id,suite_id)
      SELECT $1,o."warehouseId",o."suiteId" FROM jsonb_to_recordset($2::jsonb) AS o("warehouseId" integer,"suiteId" integer)`,
      [input.channelId, JSON.stringify(after.overrides)],
    );
    return { before: current ?? null, after };
  }

  async resolve(
    channelId: number,
    warehouseId: number,
  ): Promise<ResolvedChannelPackaging | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const row = (
        await client.query(
          `SELECT ${POLICY_PROJECTION} FROM shipping.channel_packaging_policies p WHERE p.channel_id=$1`,
          [channelId],
        )
      ).rows[0];
      if (!row) {
        await client.query("COMMIT");
        return null;
      }
      const policy = channelPackagingPolicySchema.parse(row);
      const selection = resolveChannelSuite(policy, warehouseId);
      const suite = await this.readSuite(client, selection.suiteId);
      assertSuiteBranding(policy.requirement, suite.boxes);
      const boxes = eligiblePackagingBoxes(
        suite.boxes,
        warehouseId,
        policy.requirement,
      );
      if (!boxes.length)
        throw new ShippingConfigurationError(
          "SHIPPING_SUITE_EMPTY_AT_WAREHOUSE",
          "The assigned suite has no reviewed, available boxes at the fulfillment warehouse.",
        );
      await client.query("COMMIT");
      return {
        channelId,
        warehouseId,
        suiteId: selection.suiteId,
        suiteRevision: suite.revision,
        assignmentRevision: policy.revision,
        requirement: policy.requirement,
        source: selection.source,
        boxes,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async readSuite(client: PoolClient, suiteId: number) {
    const suite = (
      await client.query(
        "SELECT current_revision,archived FROM shipping.box_suites WHERE id=$1",
        [suiteId],
      )
    ).rows[0];
    if (!suite || suite.archived)
      throw new ShippingConfigurationError(
        "SHIPPING_SUITE_UNAVAILABLE",
        "Choose an active box suite.",
      );
    const rows = await client.query(
      `SELECT ${BOX_PROJECTION} FROM shipping.box_catalog b JOIN shipping.box_suite_members m ON m.box_id=b.id
      WHERE m.suite_id=$1 AND m.revision=$2 ORDER BY b.id`,
      [suiteId, suite.current_revision],
    );
    return {
      revision: z.number().int().positive().parse(suite.current_revision),
      boxes: z.array(boxSchema).parse(rows.rows),
    };
  }

  async saveBox(
    input: SaveCatalogBox,
    actor: string,
    now: Date,
  ): Promise<{ box: CatalogBox }> {
    return configurationCommand(
      this.pool,
      `box:${input.id ?? "new"}`,
      input,
      actor,
      now,
      async (client) => {
        const current = input.id
          ? (
              await client.query(
                `SELECT ${BOX_PROJECTION} FROM shipping.box_catalog b WHERE b.id=$1 FOR UPDATE`,
                [input.id],
              )
            ).rows[0]
          : null;
        if (
          (current?.configurationRevision ?? 0) !== input.expectedRevision ||
          (input.id && !current)
        )
          throw conflict();
        const values = [
          input.code,
          input.name,
          input.kind,
          input.lengthMm,
          input.widthMm,
          input.heightMm,
          input.outerLengthMm,
          input.outerWidthMm,
          input.outerHeightMm,
          input.tareWeightGrams,
          input.maxWeightGrams,
          input.costCents,
          input.fillFactorBps,
          input.isActive,
          input.branding,
          input.expectedRevision + 1,
          now,
        ];
        const columns =
          "code,name,kind,length_mm,width_mm,height_mm,outer_length_mm,outer_width_mm,outer_height_mm,tare_weight_grams,max_weight_grams,cost_cents,fill_factor_bps,is_active,branding,configuration_revision,updated_at";
        const result = input.id
          ? await client.query(
              `UPDATE shipping.box_catalog SET (${columns})=(${values.map((_, i) => `$${i + 1}`).join(",")}) WHERE id=$18 RETURNING id`,
              [...values, input.id],
            )
          : await client.query(
              // New catalog items have no availability until a warehouse explicitly adds them.
              `INSERT INTO shipping.box_catalog(${columns},availability_reviewed,created_at) VALUES(${values.map((_, i) => `$${i + 1}`).join(",")},true,$17) RETURNING id`,
              values,
            );
        const id = result.rows[0].id;
        const box = boxSchema.parse(
          (
            await client.query(
              `SELECT ${BOX_PROJECTION} FROM shipping.box_catalog b WHERE b.id=$1`,
              [id],
            )
          ).rows[0],
        );
        return { before: current, after: { box } };
      },
      (after) => `box:${boxSchema.parse(after.box).id}`,
    );
  }

  async bulkBranding(
    input: BulkBoxBranding,
    actor: string,
    now: Date,
  ): Promise<PackagingBulkResult> {
    return configurationCommand(
      this.pool,
      "box-branding:bulk",
      input,
      actor,
      now,
      async (client) => {
        const before = (
          await client.query(
            `SELECT id,branding,configuration_revision AS revision FROM shipping.box_catalog WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE`,
            [input.boxes.map((b) => b.id)],
          )
        ).rows;
        if (
          before.length !== input.boxes.length ||
          input.boxes.some(
            (b) =>
              before.find((row) => row.id === b.id)?.revision !== b.revision,
          )
        )
          throw conflict();
        const changed = before
          .filter((b) => b.branding !== input.branding)
          .map((b) => b.id);
        await client.query(
          `UPDATE shipping.box_catalog SET branding=$2,configuration_revision=configuration_revision+1,updated_at=$3 WHERE id=ANY($1::int[])`,
          [changed, input.branding, now],
        );
        return {
          before,
          after: {
            changed: changed.length,
            skipped: before.length - changed.length,
            branding: input.branding,
            boxIds: changed,
          },
        };
      },
    );
  }

  async saveAvailability(
    input: WarehouseAvailability,
    actor: string,
    now: Date,
  ): Promise<PackagingBulkResult> {
    return configurationCommand(
      this.pool,
      "warehouse-packaging:availability",
      input,
      actor,
      now,
      async (client) => {
        const warehouseIds = input.warehouses.map((w) => w.id);
        const warehouses = (
          await client.query(
            `SELECT w.id,COALESCE(r.revision,0) AS revision FROM warehouse.warehouses w LEFT JOIN shipping.warehouse_packaging_revisions r ON r.warehouse_id=w.id WHERE w.id=ANY($1::int[]) ORDER BY w.id`,
            [warehouseIds],
          )
        ).rows;
        if (
          warehouses.length !== input.warehouses.length ||
          input.warehouses.some(
            (w) =>
              warehouses.find((row) => row.id === w.id)?.revision !==
              w.revision,
          )
        )
          throw conflict();
        const boxes = (
          await client.query(
            "SELECT id,is_active FROM shipping.box_catalog WHERE id=ANY($1::int[])",
            [input.boxIds],
          )
        ).rows;
        if (
          boxes.length !== input.boxIds.length ||
          (input.available && boxes.some((b) => !b.is_active))
        )
          throw new ShippingConfigurationError(
            "SHIPPING_BOX_UNAVAILABLE",
            "Choose existing, active packaging to make available.",
          );
        if (input.sourceSuite) {
          const suite = await this.readSuite(client, input.sourceSuite.id);
          if (
            suite.revision !== input.sourceSuite.revision ||
            input.boxIds.some((id) => !suite.boxes.some((b) => b.id === id))
          )
            throw conflict();
        }
        const before = (
          await client.query(
            `SELECT w.id AS "warehouseId",b.id AS "boxId",shipping.box_available_at(b.id,w.id,true) AS available,
        a.available AS "previousOverride" FROM warehouse.warehouses w CROSS JOIN shipping.box_catalog b
        LEFT JOIN shipping.warehouse_packaging_availability a ON a.warehouse_id=w.id AND a.box_id=b.id
        WHERE w.id=ANY($1::int[]) AND b.id=ANY($2::int[]) ORDER BY w.id,b.id`,
            [warehouseIds, input.boxIds],
          )
        ).rows;
        await client.query(
          `INSERT INTO shipping.warehouse_packaging_availability(warehouse_id,box_id,available)
        SELECT w,b,$3 FROM unnest($1::int[]) w CROSS JOIN unnest($2::int[]) b
        ON CONFLICT(warehouse_id,box_id) DO UPDATE SET available=excluded.available`,
          [warehouseIds, input.boxIds, input.available],
        );
        await client.query(
          `INSERT INTO shipping.warehouse_packaging_revisions(warehouse_id,revision) SELECT w,1 FROM unnest($1::int[]) w
        ON CONFLICT(warehouse_id) DO UPDATE SET revision=shipping.warehouse_packaging_revisions.revision+1`,
          [warehouseIds],
        );
        const changed = before.filter(
          (row) => row.previousOverride !== input.available,
        ).length;
        return {
          before: { warehouses, availability: before },
          after: {
            changed,
            skipped: before.length - changed,
            warehouseIds,
            warehouseRevisions: warehouses.map((w) => ({
              id: w.id,
              revision: w.revision + 1,
            })),
            boxIds: input.boxIds,
            available: input.available,
          },
        };
      },
    );
  }

  async assignWarehouseSuites(
    input: WarehouseSuiteAssignment,
    actor: string,
    now: Date,
  ): Promise<PackagingBulkResult> {
    return configurationCommand(
      this.pool,
      `channel-packaging:${input.channelId}`,
      input,
      actor,
      now,
      async (client) => {
        const row = (
          await client.query(
            `SELECT ${POLICY_PROJECTION} FROM shipping.channel_packaging_policies p WHERE p.channel_id=$1 FOR UPDATE`,
            [input.channelId],
          )
        ).rows[0];
        if ((row?.revision ?? 0) !== input.expectedRevision) throw conflict();
        if (!row && !input.initialPolicy) throw conflict();
        const current = row
          ? channelPackagingPolicySchema.parse(row)
          : {
              channelId: input.channelId,
              revision: 0,
              defaultSuiteId: input.initialPolicy!.defaultSuiteId,
              requirement: input.initialPolicy!.requirement,
              overrides: [],
            };
        const warehouses = (
          await client.query(
            "SELECT id FROM warehouse.warehouses WHERE id=ANY($1::int[])",
            [input.warehouseIds],
          )
        ).rows;
        if (warehouses.length !== input.warehouseIds.length) throw conflict();
        const { overrides, changed, skipped } = planWarehouseSuiteAssignment(
          current.overrides,
          input,
        );
        const saved =
          changed || !row
            ? await this.persistPolicy(client, {
                commandId: input.commandId,
                channelId: current.channelId,
                expectedRevision: current.revision,
                defaultSuiteId: current.defaultSuiteId,
                requirement: current.requirement,
                overrides,
              })
            : { before: current, after: current };
        return {
          before: saved.before,
          after: {
            changed,
            skipped,
            policy: saved.after,
          },
        };
      },
    );
  }
}
