import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { pool } from "../../../db";
import { z } from "zod";
import {
  NO_PROGRAM_CHARGES,
  programChargesSchema,
  packagingConfigurationSchema,
  dropshipSharedShippingConfigSchema,
  type FulfillmentChannel,
  type PackagingConfiguration,
  type BoxSuiteSummary,
  type PackagingAssignment,
  type saveBoxSuiteSchema,
  type savePackagingAssignmentSchema,
  type saveProgramChargesSchema,
  type saveFulfillmentServiceSchema,
  type saveDropshipProgramSchema,
  type DropshipSharedShippingConfig,
  type changeSuiteStatusSchema,
  type resetPackagingAssignmentSchema,
  type resetDropshipProgramSchema,
} from "@shared/shipping/configuration";
import { resolvePackagingAssignment } from "../domain/packaging-assignment";
import type { CartonizeBox } from "../../cartonization/domain/cartonize";
import type { SharedShippingConfigurationStore } from "../application/shared-configuration.port";

import { ShippingConfigurationError } from "../domain/configuration-error";
export { ShippingConfigurationError } from "../domain/configuration-error";
const conflict = () =>
  new ShippingConfigurationError(
    "SHIPPING_CONFIG_CHANGED",
    "Configuration changed. Reload before saving.",
  );

export class SharedShippingConfigurationRepository
  implements SharedShippingConfigurationStore
{
  constructor(private readonly dbPool: Pool = pool) {}

  async dropshipConfig(
    configuredChannelId: number | null,
  ): Promise<DropshipSharedShippingConfig> {
    const [packaging, programs, assignments, levels, selected] =
      await Promise.all([
        this.listPackaging(),
        this.dbPool.query(
          "SELECT id,name FROM shipping.rate_books WHERE status='active' ORDER BY name",
        ),
        configuredChannelId === null
          ? this.dbPool
              .query(`SELECT origin_warehouse_id AS "warehouseId",rate_book_id AS "rateBookId"
          FROM shipping.rate_book_assignments WHERE pricing_channel='dropship' AND rate_purpose='vendor_fulfillment_charge' AND is_active`)
          : this.dbPool.query(
              `SELECT r.origin_warehouse_id AS "warehouseId",r.rate_book_id AS "rateBookId"
          FROM shipping.channel_policy_routes r JOIN shipping.channel_policies p ON p.id=r.policy_id
          WHERE p.channel_id=$1 AND p.status='active' AND p.purpose='vendor_fulfillment_charge'`,
              [configuredChannelId],
            ),
        this.dbPool.query(
          "SELECT id,display_name AS name FROM shipping.service_levels WHERE is_active ORDER BY sort_order,id",
        ),
        this.dbPool.query(
          "SELECT service_level_id AS id,revision FROM shipping.fulfillment_channel_services WHERE channel='dropship'",
        ),
      ]);
    return dropshipSharedShippingConfigSchema.parse({
      packaging,
      programs: programs.rows,
      assignments: assignments.rows,
      serviceLevels: levels.rows,
      selectedService: selected.rows[0] ?? null,
      configuredChannelId,
    });
  }

  async saveDropshipProgram(
    input: z.infer<typeof saveDropshipProgramSchema>,
    actor: string,
    now: Date,
  ) {
    return this.command(
      `dropship-program:${input.warehouseId ?? "default"}`,
      input,
      actor,
      now,
      async (client) => {
        const current = (
          await client.query(
            `SELECT id,rate_book_id FROM shipping.rate_book_assignments
        WHERE pricing_channel='dropship' AND rate_purpose='vendor_fulfillment_charge' AND is_active
          AND origin_warehouse_id IS NOT DISTINCT FROM $1::int FOR UPDATE`,
            [input.warehouseId],
          )
        ).rows;
        if (
          current.length > 1 ||
          (current[0]?.rate_book_id ?? null) !== input.expectedProgramId
        )
          throw conflict();
        if (
          !(
            await client.query(
              "SELECT id FROM shipping.rate_books WHERE id=$1 AND status='active' FOR UPDATE",
              [input.rateBookId],
            )
          ).rows.length
        ) {
          throw new ShippingConfigurationError(
            "SHIPPING_PROGRAM_UNAVAILABLE",
            "Select an active pricing program.",
          );
        }
        if (current[0])
          await client.query(
            "UPDATE shipping.rate_book_assignments SET is_active=false,updated_at=$2 WHERE id=$1",
            [current[0].id, now],
          );
        await client.query(
          `INSERT INTO shipping.rate_book_assignments(rate_book_id,pricing_channel,rate_purpose,origin_warehouse_id,is_active)
        VALUES ($1,'dropship','vendor_fulfillment_charge',$2,true)`,
          [input.rateBookId, input.warehouseId],
        );
        return {
          before: current[0] ?? null,
          after: {
            warehouseId: input.warehouseId,
            rateBookId: input.rateBookId,
          },
        };
      },
    );
  }

  async resetDropshipProgram(
    input: z.infer<typeof resetDropshipProgramSchema>,
    actor: string,
    now: Date,
  ) {
    return this.command(
      `dropship-program:${input.warehouseId}`,
      input,
      actor,
      now,
      async (client) => {
        const current = (
          await client.query(
            `SELECT id,rate_book_id FROM shipping.rate_book_assignments
        WHERE pricing_channel='dropship' AND rate_purpose='vendor_fulfillment_charge' AND is_active
        AND origin_warehouse_id=$1 FOR UPDATE`,
            [input.warehouseId],
          )
        ).rows;
        if (
          current.length !== 1 ||
          current[0].rate_book_id !== input.expectedProgramId
        )
          throw conflict();
        const fallback = (
          await client.query(`SELECT a.id FROM shipping.rate_book_assignments a
        JOIN shipping.rate_books b ON b.id=a.rate_book_id AND b.status='active'
        WHERE a.pricing_channel='dropship' AND a.rate_purpose='vendor_fulfillment_charge' AND a.is_active
        AND a.origin_warehouse_id IS NULL FOR UPDATE OF a,b`)
        ).rows;
        if (fallback.length !== 1)
          throw new ShippingConfigurationError(
            "SHIPPING_PROGRAM_DEFAULT_UNAVAILABLE",
            "Configure one active channel-default program before removing a warehouse override.",
          );
        await client.query(
          "UPDATE shipping.rate_book_assignments SET is_active=false,updated_at=$2 WHERE id=$1",
          [current[0].id, now],
        );
        return {
          before: current[0],
          after: { warehouseId: input.warehouseId },
        };
      },
    );
  }

  async saveService(
    input: z.infer<typeof saveFulfillmentServiceSchema>,
    actor: string,
    now: Date,
  ) {
    return this.command(
      `fulfillment-service:${input.channel}`,
      input,
      actor,
      now,
      async (client) => {
        const current = (
          await client.query(
            "SELECT * FROM shipping.fulfillment_channel_services WHERE channel=$1 FOR UPDATE",
            [input.channel],
          )
        ).rows[0];
        if ((current?.revision ?? 0) !== input.expectedRevision)
          throw conflict();
        if (
          !(
            await client.query(
              "SELECT id FROM shipping.service_levels WHERE id=$1 AND is_active",
              [input.serviceLevelId],
            )
          ).rows.length
        )
          throw new ShippingConfigurationError(
            "SHIPPING_SERVICE_REQUIRED",
            "Select an active service level.",
          );
        const revision = input.expectedRevision + 1;
        await client.query(
          `INSERT INTO shipping.fulfillment_channel_services(channel,service_level_id,revision) VALUES($1,$2,$3)
        ON CONFLICT(channel) DO UPDATE SET service_level_id=excluded.service_level_id,revision=excluded.revision`,
          [input.channel, input.serviceLevelId, revision],
        );
        return {
          before: current ?? null,
          after: { id: input.serviceLevelId, revision },
        };
      },
    );
  }

  async readChargeConfiguration(bookId: number) {
    if (
      !(
        await this.dbPool.query(
          "SELECT id FROM shipping.rate_books WHERE id=$1",
          [bookId],
        )
      ).rows.length
    ) {
      throw new ShippingConfigurationError(
        "SHIPPING_PROGRAM_UNAVAILABLE",
        "Pricing program does not exist.",
        404,
      );
    }
    const row = (
      await this.dbPool.query(
        "SELECT revision,charges FROM shipping.rate_book_charge_revisions WHERE rate_book_id=$1 ORDER BY revision DESC LIMIT 1",
        [bookId],
      )
    ).rows[0];
    return row
      ? {
          revision: row.revision as number,
          charges: programChargesSchema.parse(row.charges),
        }
      : {
          revision: 0,
          charges: programChargesSchema.parse(NO_PROGRAM_CHARGES),
        };
  }

  async loadPackaging(
    channel: FulfillmentChannel,
    warehouseId: number,
  ): Promise<{
    suiteId: number;
    suiteRevision: number;
    assignmentRevision: number;
    boxes: CartonizeBox[];
  }> {
    // One MVCC statement: membership, current revision, and stock cannot come
    // from different admin edits during a quote.
    const result = await this.dbPool.query(
      `SELECT a.channel,a.warehouse_id AS "warehouseId",
      a.suite_id AS "suiteId",a.revision,s.current_revision AS "suiteRevision",
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',b.id,'code',b.code,'kind',b.kind,
        'lengthMm',b.length_mm,'widthMm',b.width_mm,'heightMm',b.height_mm,
        'outerLengthMm',b.outer_length_mm,'outerWidthMm',b.outer_width_mm,'outerHeightMm',b.outer_height_mm,
        'tareWeightGrams',b.tare_weight_grams,'maxWeightGrams',b.max_weight_grams,
        'costCents',b.cost_cents,'fillFactorBps',b.fill_factor_bps,'isActive',b.is_active) ORDER BY b.id)
        FROM shipping.box_suite_members m JOIN shipping.box_catalog b ON b.id=m.box_id
        WHERE m.suite_id=s.id AND m.revision=s.current_revision AND b.is_active
        AND (NOT EXISTS (SELECT 1 FROM shipping.box_warehouse_stock stock WHERE stock.box_id=b.id)
          OR EXISTS (SELECT 1 FROM shipping.box_warehouse_stock stock
            WHERE stock.box_id=b.id AND stock.warehouse_id=$2 AND stock.is_stocked))), '[]'::jsonb) AS boxes
      FROM shipping.packaging_assignments a JOIN shipping.box_suites s ON s.id=a.suite_id
      WHERE a.is_active AND NOT s.archived AND a.channel=$1 AND (a.warehouse_id=$2 OR a.warehouse_id IS NULL)`,
      [channel, warehouseId],
    );
    const assignment = resolvePackagingAssignment(
      result.rows as PackagingAssignment[],
      channel,
      warehouseId,
    );
    const row = result.rows.find(
      (r) => r.warehouseId === assignment.warehouseId,
    )!;
    if (!row.boxes.length)
      throw new ShippingConfigurationError(
        "SHIPPING_SUITE_EMPTY_AT_WAREHOUSE",
        "The assigned suite has no available boxes at this warehouse.",
      );
    return {
      suiteId: row.suiteId,
      suiteRevision: row.suiteRevision,
      assignmentRevision: row.revision,
      boxes: row.boxes as CartonizeBox[],
    };
  }

  async loadService(
    channel: FulfillmentChannel,
  ): Promise<{ serviceLevelCode: string; revision: number }> {
    const result = await this.dbPool.query(
      `SELECT s.code AS "serviceLevelCode",c.revision
      FROM shipping.fulfillment_channel_services c JOIN shipping.service_levels s ON s.id=c.service_level_id
      WHERE c.channel=$1 AND s.is_active`,
      [channel],
    );
    if (result.rows.length !== 1)
      throw new ShippingConfigurationError(
        "SHIPPING_SERVICE_REQUIRED",
        "Select an active fulfillment service level for this channel.",
      );
    return result.rows[0];
  }

  async history(key: string) {
    return (
      await this.dbPool.query(
        `SELECT actor_id AS "actorId",created_at AS "createdAt",
      before_state AS "before",after_state AS "after" FROM shipping.configuration_commands
      WHERE resource_key=$1 ORDER BY created_at DESC LIMIT 50`,
        [key],
      )
    ).rows;
  }

  /** All edits are serialized, idempotent and atomically audited. No secrets are stored. */
  private async command<T>(
    key: string,
    input: { commandId: string },
    actor: string,
    now: Date,
    work: (client: PoolClient) => Promise<{ before: unknown; after: T }>,
    historyKey: (after: T) => string = () => key,
  ): Promise<T> {
    const client = await this.dbPool.connect();
    const hash = createHash("sha256")
      .update(JSON.stringify({ key, input, actor }))
      .digest("hex");
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('shipping-shared-config'))",
      );
      const replay = await client.query(
        "SELECT request_hash,after_state FROM shipping.configuration_commands WHERE command_id=$1",
        [input.commandId],
      );
      if (replay.rows.length) {
        if (replay.rows[0].request_hash !== hash)
          throw new ShippingConfigurationError(
            "SHIPPING_COMMAND_REUSED",
            "Command was already used for different settings.",
          );
        await client.query("COMMIT");
        return replay.rows[0].after_state as T;
      }
      const result = await work(client);
      await client.query(
        `INSERT INTO shipping.configuration_commands
        (command_id,request_hash,actor_id,resource_key,before_state,after_state,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          input.commandId,
          hash,
          actor,
          historyKey(result.after),
          JSON.stringify(result.before),
          JSON.stringify(result.after),
          now,
        ],
      );
      await client.query("COMMIT");
      return result.after;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listPackaging(): Promise<PackagingConfiguration> {
    // One statement gives the UI a consistent snapshot of suites and assignments.
    const result = await this.dbPool.query(`SELECT
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'revision',s.current_revision,'archived',s.archived,'imported',s.imported,
        'boxIds',COALESCE((SELECT jsonb_agg(m.box_id ORDER BY m.box_id) FROM shipping.box_suite_members m
          WHERE m.suite_id=s.id AND m.revision=s.current_revision),'[]'::jsonb)) ORDER BY s.name)
        FROM shipping.box_suites s),'[]'::jsonb) AS suites,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('channel',channel,'warehouseId',warehouse_id,
        'suiteId',suite_id,'revision',revision) ORDER BY channel,warehouse_id NULLS FIRST)
        FROM shipping.packaging_assignments WHERE is_active),'[]'::jsonb) AS assignments,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'code',code,'name',name,'isActive',is_active) ORDER BY code)
        FROM shipping.box_catalog),'[]'::jsonb) AS boxes,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name) ORDER BY name)
        FROM warehouse.warehouses),'[]'::jsonb) AS warehouses`);
    return packagingConfigurationSchema.parse(result.rows[0]);
  }

  async saveSuite(
    input: z.infer<typeof saveBoxSuiteSchema>,
    actor: string,
    now: Date,
  ): Promise<BoxSuiteSummary> {
    return this.command(
      `suite:${input.id ?? "new"}`,
      input,
      actor,
      now,
      async (client) => {
        const current = input.id
          ? (
              await client.query(
                "SELECT id,name,current_revision,archived FROM shipping.box_suites WHERE id=$1 FOR UPDATE",
                [input.id],
              )
            ).rows[0]
          : null;
        if (
          (current?.current_revision ?? 0) !== input.expectedRevision ||
          (input.id && !current)
        )
          throw conflict();
        if (current?.archived)
          throw new ShippingConfigurationError(
            "SHIPPING_SUITE_ARCHIVED",
            "Restore this suite before editing it.",
          );
        const boxes = await client.query(
          "SELECT id FROM shipping.box_catalog WHERE id=ANY($1::int[]) AND is_active=true",
          [input.boxIds],
        );
        if (boxes.rows.length !== input.boxIds.length)
          throw new ShippingConfigurationError(
            "SHIPPING_BOX_UNAVAILABLE",
            "Every suite member must be an active catalog box.",
          );
        if (current) {
          // Evaluate the replacement membership against every warehouse where
          // this suite currently wins, including inherited channel defaults.
          const stranded = await client.query(
            `SELECT DISTINCT w.name FROM warehouse.warehouses w
          JOIN shipping.packaging_assignments a ON a.is_active AND a.suite_id=$1 AND
            (a.warehouse_id=w.id OR (a.warehouse_id IS NULL AND NOT EXISTS
              (SELECT 1 FROM shipping.packaging_assignments override
                WHERE override.is_active AND override.channel=a.channel AND override.warehouse_id=w.id)))
          WHERE NOT EXISTS (SELECT 1 FROM shipping.box_catalog b WHERE b.id=ANY($2::int[]) AND b.is_active
            AND (NOT EXISTS(SELECT 1 FROM shipping.box_warehouse_stock stock WHERE stock.box_id=b.id)
              OR EXISTS(SELECT 1 FROM shipping.box_warehouse_stock stock
                WHERE stock.box_id=b.id AND stock.warehouse_id=w.id AND stock.is_stocked)))`,
            [current.id, input.boxIds],
          );
          if (stranded.rows.length)
            throw new ShippingConfigurationError(
              "SHIPPING_SUITE_STRANDS_WAREHOUSE",
              `This change leaves assigned warehouses without available packaging: ${stranded.rows.map((row) => row.name).join(", ")}.`,
            );
        }
        const revision = input.expectedRevision + 1;
        const row = current
          ? (
              await client.query(
                "UPDATE shipping.box_suites SET name=$2,current_revision=$3 WHERE id=$1 RETURNING id",
                [current.id, input.name, revision],
              )
            ).rows[0]
          : (
              await client.query(
                "INSERT INTO shipping.box_suites(name,current_revision) VALUES ($1,1) RETURNING id",
                [input.name],
              )
            ).rows[0];
        await client.query(
          "INSERT INTO shipping.box_suite_revisions(suite_id,revision,name,created_at,actor_id) VALUES ($1,$2,$3,$4,$5)",
          [row.id, revision, input.name, now, actor],
        );
        await client.query(
          "INSERT INTO shipping.box_suite_members(suite_id,revision,box_id) SELECT $1,$2,unnest($3::int[])",
          [row.id, revision, input.boxIds],
        );
        return {
          before: current,
          after: {
            id: row.id,
            name: input.name,
            revision,
            boxIds: [...input.boxIds].sort((a, b) => a - b),
          },
        };
      },
      (suite) => `suite:${suite.id}`,
    );
  }

  async saveAssignment(
    input: z.infer<typeof savePackagingAssignmentSchema>,
    actor: string,
    now: Date,
  ): Promise<PackagingAssignment> {
    return this.command(
      `packaging:${input.channel}:${input.warehouseId ?? "default"}`,
      input,
      actor,
      now,
      async (client) => {
        const current = (
          await client.query(
            "SELECT * FROM shipping.packaging_assignments WHERE channel=$1 AND warehouse_id IS NOT DISTINCT FROM $2::int FOR UPDATE",
            [input.channel, input.warehouseId],
          )
        ).rows[0];
        if (
          (current?.is_active ? current.revision : 0) !== input.expectedRevision
        )
          throw conflict();
        const available = await client.query(
          `SELECT 1 FROM shipping.box_suites s
        JOIN shipping.box_suite_members m ON m.suite_id=s.id AND m.revision=s.current_revision
        JOIN shipping.box_catalog b ON b.id=m.box_id AND b.is_active
        WHERE s.id=$1 AND NOT s.archived AND ($2::int IS NULL
          OR NOT EXISTS(SELECT 1 FROM shipping.box_warehouse_stock stock WHERE stock.box_id=b.id)
          OR EXISTS(SELECT 1 FROM shipping.box_warehouse_stock stock WHERE stock.box_id=b.id AND stock.warehouse_id=$2 AND stock.is_stocked)) LIMIT 1`,
          [input.suiteId, input.warehouseId],
        );
        if (!available.rows.length)
          throw new ShippingConfigurationError(
            "SHIPPING_SUITE_EMPTY_AT_WAREHOUSE",
            "This suite has no active boxes available for this assignment.",
          );
        const revision = (current?.revision ?? 0) + 1;
        if (current)
          await client.query(
            "UPDATE shipping.packaging_assignments SET suite_id=$2,revision=$3,is_active=true WHERE id=$1",
            [current.id, input.suiteId, revision],
          );
        else
          await client.query(
            "INSERT INTO shipping.packaging_assignments(channel,warehouse_id,suite_id,revision) VALUES ($1,$2,$3,$4)",
            [input.channel, input.warehouseId, input.suiteId, revision],
          );
        return {
          before: current ?? null,
          after: {
            channel: input.channel,
            warehouseId: input.warehouseId,
            suiteId: input.suiteId,
            revision,
          },
        };
      },
    );
  }

  async changeSuiteStatus(
    input: z.infer<typeof changeSuiteStatusSchema>,
    actor: string,
    now: Date,
  ): Promise<BoxSuiteSummary> {
    return this.command(
      `suite:${input.id}`,
      input,
      actor,
      now,
      async (client) => {
        const current = (
          await client.query(
            "SELECT id,name,current_revision,archived FROM shipping.box_suites WHERE id=$1 FOR UPDATE",
            [input.id],
          )
        ).rows[0];
        if (!current || current.current_revision !== input.expectedRevision)
          throw conflict();
        if (input.archived) {
          const usages = (
            await client.query(
              "SELECT channel,warehouse_id FROM shipping.packaging_assignments WHERE suite_id=$1 AND is_active ORDER BY channel,warehouse_id NULLS FIRST",
              [input.id],
            )
          ).rows;
          if (usages.length)
            throw new ShippingConfigurationError(
              "SHIPPING_SUITE_IN_USE",
              "Reassign this suite before archiving it. It is still used by " +
                usages
                  .map(
                    (a) =>
                      `${a.channel} / ${a.warehouse_id === null ? "channel default" : `warehouse ${a.warehouse_id}`}`,
                  )
                  .join(", ") +
                ".",
            );
        }
        const revision = current.current_revision + 1;
        // Lifecycle changes also advance the revision, invalidating stale editors.
        await client.query(
          "INSERT INTO shipping.box_suite_revisions(suite_id,revision,name,created_at,actor_id) VALUES($1,$2,$3,$4,$5)",
          [input.id, revision, current.name, now, actor],
        );
        const members = (
          await client.query(
            "INSERT INTO shipping.box_suite_members(suite_id,revision,box_id) SELECT suite_id,$2,box_id FROM shipping.box_suite_members WHERE suite_id=$1 AND revision=$3 RETURNING box_id",
            [input.id, revision, current.current_revision],
          )
        ).rows;
        await client.query(
          "UPDATE shipping.box_suites SET archived=$2,current_revision=$3 WHERE id=$1",
          [input.id, input.archived, revision],
        );
        return {
          before: current,
          after: {
            id: input.id,
            name: current.name as string,
            archived: input.archived,
            revision,
            boxIds: members
              .map((m) => m.box_id as number)
              .sort((a, b) => a - b),
          },
        };
      },
    );
  }

  async resetAssignment(
    input: z.infer<typeof resetPackagingAssignmentSchema>,
    actor: string,
    now: Date,
  ) {
    return this.command(
      `packaging:${input.channel}:${input.warehouseId}`,
      input,
      actor,
      now,
      async (client) => {
        const current = (
          await client.query(
            "SELECT * FROM shipping.packaging_assignments WHERE channel=$1 AND warehouse_id=$2 AND is_active FOR UPDATE",
            [input.channel, input.warehouseId],
          )
        ).rows[0];
        if (!current || current.revision !== input.expectedRevision)
          throw conflict();
        const fallback = await client.query(
          `SELECT 1 FROM shipping.packaging_assignments a
        JOIN shipping.box_suites s ON s.id=a.suite_id AND NOT s.archived
        JOIN shipping.box_suite_members m ON m.suite_id=s.id AND m.revision=s.current_revision
        JOIN shipping.box_catalog b ON b.id=m.box_id AND b.is_active
        WHERE a.channel=$1 AND a.warehouse_id IS NULL AND a.is_active AND
        (NOT EXISTS(SELECT 1 FROM shipping.box_warehouse_stock stock WHERE stock.box_id=b.id)
         OR EXISTS(SELECT 1 FROM shipping.box_warehouse_stock stock WHERE stock.box_id=b.id AND stock.warehouse_id=$2 AND stock.is_stocked)) LIMIT 1`,
          [input.channel, input.warehouseId],
        );
        if (!fallback.rows.length)
          throw new ShippingConfigurationError(
            "SHIPPING_PACKAGING_DEFAULT_UNAVAILABLE",
            "The channel default has no available packaging at this warehouse. Configure a usable default before removing this override.",
          );
        await client.query(
          "UPDATE shipping.packaging_assignments SET is_active=false,revision=revision+1 WHERE id=$1",
          [current.id],
        );
        return {
          before: current,
          after: { channel: input.channel, warehouseId: input.warehouseId },
        };
      },
    );
  }

  async loadCharges(bookId: number, at: Date) {
    const result = await this.dbPool.query(
      `SELECT revision,charges FROM shipping.rate_book_charge_revisions
      WHERE rate_book_id=$1 AND effective_from <= $2 AND (effective_to IS NULL OR effective_to > $2)`,
      [bookId, at],
    );
    if (result.rows.length > 1)
      throw new ShippingConfigurationError(
        "SHIPPING_CHARGE_AMBIGUOUS",
        "Program has overlapping charge revisions.",
      );
    if (!result.rows.length) {
      const book = (
        await this.dbPool.query(
          "SELECT charge_policy_required FROM shipping.rate_books WHERE id=$1",
          [bookId],
        )
      ).rows[0];
      if (!book)
        throw new ShippingConfigurationError(
          "SHIPPING_PROGRAM_UNAVAILABLE",
          "Pricing program does not exist.",
        );
      if (book.charge_policy_required)
        throw new ShippingConfigurationError(
          "SHIPPING_CHARGE_POLICY_REQUIRED",
          "This pricing program has no charge policy effective at the quote time.",
        );
    }
    return result.rows.length
      ? {
          revision: result.rows[0].revision as number,
          charges: programChargesSchema.parse(result.rows[0].charges),
        }
      : {
          revision: 0,
          charges: programChargesSchema.parse(NO_PROGRAM_CHARGES),
        };
  }

  async saveCharges(
    bookId: number,
    input: z.infer<typeof saveProgramChargesSchema>,
    actor: string,
    now: Date,
  ) {
    return this.command(
      `program-charges:${bookId}`,
      input,
      actor,
      now,
      async (client) => {
        const book = (
          await client.query(
            "SELECT id FROM shipping.rate_books WHERE id=$1 AND status='active' FOR UPDATE",
            [bookId],
          )
        ).rows[0];
        if (!book)
          throw new ShippingConfigurationError(
            "SHIPPING_PROGRAM_UNAVAILABLE",
            "Select an active pricing program.",
          );
        const current = (
          await client.query(
            "SELECT * FROM shipping.rate_book_charge_revisions WHERE rate_book_id=$1 ORDER BY revision DESC LIMIT 1 FOR UPDATE",
            [bookId],
          )
        ).rows[0];
        if ((current?.revision ?? 0) !== input.expectedRevision)
          throw conflict();
        if (
          current &&
          new Date(current.effective_from).getTime() >= now.getTime()
        ) {
          throw new ShippingConfigurationError(
            "SHIPPING_CHARGES_SCHEDULED",
            "This program has a scheduled charge revision. It cannot be replaced before its effective time.",
          );
        }
        await client.query(
          `UPDATE shipping.rate_book_charge_revisions SET effective_to=$2
        WHERE rate_book_id=$1 AND effective_from < $2 AND (effective_to IS NULL OR effective_to > $2)`,
          [bookId, now],
        );
        const after = {
          revision: input.expectedRevision + 1,
          charges: input.charges,
        };
        await client.query(
          "INSERT INTO shipping.rate_book_charge_revisions(rate_book_id,revision,charges,effective_from,actor_id) VALUES ($1,$2,$3,$4,$5)",
          [bookId, after.revision, JSON.stringify(after.charges), now, actor],
        );
        return { before: current ?? null, after };
      },
    );
  }
}
