import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { pool as defaultPool } from "../../../db";
import {
  boxBrandingSchema,
  channelPackagingPolicySchema,
  packagingPolicyOverviewSchema,
  type SaveCatalogBox,
  type SaveChannelPackaging,
  type ChannelPackagingPolicy,
  type PackagingPolicyOverview,
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

const conflict = () =>
  new ShippingConfigurationError(
    "SHIPPING_CONFIG_CHANGED",
    "Configuration changed. Reload before saving.",
  );
const boxSchema = z.object({
  id: z.number().int().positive(),
  code: z.string(),
  name: z.string(),
  kind: z.enum(["box", "mailer", "envelope"]),
  lengthMm: z.number().int().positive(),
  widthMm: z.number().int().positive(),
  heightMm: z.number().int().positive(),
  outerLengthMm: z.number().int().positive().nullable(),
  outerWidthMm: z.number().int().positive().nullable(),
  outerHeightMm: z.number().int().positive().nullable(),
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
  b.fill_factor_bps AS "fillFactorBps",b.is_active AS "isActive",b.branding,b.availability_reviewed AS "availabilityReviewed",
  b.configuration_revision AS "configurationRevision",COALESCE((SELECT jsonb_agg(s.warehouse_id ORDER BY s.warehouse_id)
    FROM shipping.box_warehouse_stock s WHERE s.box_id=b.id AND s.is_stocked),'[]'::jsonb) AS "warehouseIds"`;
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
        "SELECT id,name FROM warehouse.warehouses ORDER BY name,id",
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
      async (client) => {
        const current = (
          await client.query(
            `SELECT ${POLICY_PROJECTION} FROM shipping.channel_packaging_policies p WHERE p.channel_id=$1 FOR UPDATE`,
            [input.channelId],
          )
        ).rows[0];
        if ((current?.revision ?? 0) !== input.expectedRevision)
          throw conflict();
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
              (b) =>
                b.isActive && b.availabilityReviewed && b.warehouseIds.length,
            )
          ) {
            throw new ShippingConfigurationError(
              "SHIPPING_SUITE_AVAILABILITY_REQUIRED",
              "Review box availability in the catalog before assigning this suite.",
            );
          }
        }
        // An explicit override must be usable. Never save it and silently use a default instead.
        for (const override of input.overrides) {
          const boxes = suiteBoxes.get(override.suiteId)!;
          if (
            !eligiblePackagingBoxes(
              boxes,
              override.warehouseId,
              input.requirement,
            ).length
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
        for (const o of after.overrides)
          await client.query(
            "INSERT INTO shipping.channel_packaging_overrides(channel_id,warehouse_id,suite_id) VALUES($1,$2,$3)",
            [input.channelId, o.warehouseId, o.suiteId],
          );
        return { before: current ?? null, after };
      },
    );
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
        const warehouses = await client.query(
          "SELECT id FROM warehouse.warehouses WHERE id=ANY($1::int[])",
          [input.warehouseIds],
        );
        if (warehouses.rows.length !== input.warehouseIds.length)
          throw new ShippingConfigurationError(
            "SHIPPING_WAREHOUSE_REQUIRED",
            "A selected warehouse no longer exists.",
          );
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
              `UPDATE shipping.box_catalog SET (${columns})=(${values.map((_, i) => `$${i + 1}`).join(",")}),availability_reviewed=true WHERE id=$18 RETURNING id`,
              [...values, input.id],
            )
          : await client.query(
              `INSERT INTO shipping.box_catalog(${columns},availability_reviewed,created_at) VALUES(${values.map((_, i) => `$${i + 1}`).join(",")},true,$17) RETURNING id`,
              values,
            );
        const id = result.rows[0].id;
        await client.query(
          "DELETE FROM shipping.box_warehouse_stock WHERE box_id=$1",
          [id],
        );
        for (const warehouseId of [...input.warehouseIds].sort((a, b) => a - b))
          await client.query(
            "INSERT INTO shipping.box_warehouse_stock(box_id,warehouse_id,is_stocked) VALUES($1,$2,true)",
            [id, warehouseId],
          );
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
}
