import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { DropshipError } from "../domain/errors";
import type {
  CreateDropshipRateTableInput,
  DropshipBoxConfigRecord,
  DropshipInsurancePoolPolicyRecord,
  DropshipPackageProfileConfigRecord,
  DropshipRateTableConfigRecord,
  DropshipRateTableRowConfigRecord,
  DropshipShippingConfigCommandContext,
  DropshipShippingConfigMutationResult,
  DropshipShippingConfigOverview,
  DropshipShippingConfigRepository,
  DropshipShippingMarkupPolicyRecord,
  DropshipZoneRuleConfigRecord,
  ListDropshipShippingConfigInput,
  NormalizedCreateDropshipInsurancePolicyInput,
  NormalizedCreateDropshipMarkupPolicyInput,
  NormalizedCreateDropshipRateTableInput,
  NormalizedUpsertDropshipBoxInput,
  NormalizedUpsertDropshipPackageProfileInput,
  NormalizedUpsertDropshipZoneRuleInput,
} from "../application/dropship-shipping-config-service";

interface BoxRow {
  id: number;
  code: string;
  name: string;
  length_mm: number;
  width_mm: number;
  height_mm: number;
  tare_weight_grams: number;
  max_weight_grams: number | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

interface PackageProfileRow {
  id: number;
  product_variant_id: number;
  product_sku: string | null;
  product_name: string | null;
  variant_sku: string | null;
  variant_name: string | null;
  weight_grams: number;
  length_mm: number;
  width_mm: number;
  height_mm: number;
  ship_alone: boolean;
  default_carrier: string | null;
  default_service: string | null;
  default_box_id: number | null;
  max_units_per_package: number | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

interface ZoneRuleRow {
  id: number;
  origin_warehouse_id: number;
  destination_country: string;
  destination_region: string | null;
  postal_prefix: string | null;
  zone: string;
  priority: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

interface RateTableRow {
  id: number;
  carrier: string;
  service: string;
  currency: string;
  status: string;
  effective_from: Date;
  effective_to: Date | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}

interface RateTableLineRow {
  id: number;
  rate_table_id: number;
  warehouse_id: number | null;
  destination_zone: string;
  min_weight_grams: number;
  max_weight_grams: number;
  rate_cents: string | number;
  created_at: Date;
}

interface MarkupPolicyRow {
  id: number;
  name: string;
  markup_bps: number;
  fixed_markup_cents: string | number;
  min_markup_cents: string | number | null;
  max_markup_cents: string | number | null;
  is_active: boolean;
  effective_from: Date;
  effective_to: Date | null;
  created_at: Date;
}

interface InsurancePolicyRow {
  id: number;
  name: string;
  fee_bps: number;
  min_fee_cents: string | number | null;
  max_fee_cents: string | number | null;
  is_active: boolean;
  effective_from: Date;
  effective_to: Date | null;
  created_at: Date;
}

interface AdminCommandRow {
  id: number;
  command_type: string;
  request_hash: string;
  entity_type: string;
  entity_id: string | null;
}

export class PgDropshipShippingConfigRepository implements DropshipShippingConfigRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async getOverview(
    input: ListDropshipShippingConfigInput & { generatedAt: Date },
  ): Promise<DropshipShippingConfigOverview> {
    const client = await this.dbPool.connect();
    try {
      const boxes = await listBoxesWithClient(client);
      const packageProfiles = await listPackageProfilesWithClient(client, input);
      const zoneRules = await listZoneRulesWithClient(client);
      const rateTables = await listRateTablesWithClient(client, input.rateTableLimit);
      const activeMarkupPolicy = await loadActiveMarkupPolicyWithClient(client, input.generatedAt);
      const activeInsurancePolicy = await loadActiveInsurancePolicyWithClient(client, input.generatedAt);

      return {
        boxes,
        packageProfiles,
        zoneRules,
        rateTables,
        activeMarkupPolicy,
        activeInsurancePolicy,
        generatedAt: input.generatedAt,
      };
    } finally {
      client.release();
    }
  }

  async upsertBox(
    input: NormalizedUpsertDropshipBoxInput & DropshipShippingConfigCommandContext,
  ): Promise<DropshipShippingConfigMutationResult<DropshipBoxConfigRecord>> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const command = await claimAdminConfigCommand(client, "shipping_box_upserted", input);
      if (command.idempotentReplay) {
        const box = await loadBoxByIdWithClient(client, parseEntityId(command.entityId, "dropship_box_catalog"));
        await client.query("COMMIT");
        return { record: box, idempotentReplay: true };
      }

      const result = input.boxId
        ? await client.query<BoxRow>(
          `UPDATE dropship.dropship_box_catalog
           SET code = $2, name = $3, length_mm = $4, width_mm = $5,
               height_mm = $6, tare_weight_grams = $7, max_weight_grams = $8,
               is_active = $9, updated_at = $10
           WHERE id = $1
           RETURNING id, code, name, length_mm, width_mm, height_mm,
                     tare_weight_grams, max_weight_grams, is_active,
                     created_at, updated_at`,
          [
            input.boxId,
            input.code,
            input.name,
            input.lengthMm,
            input.widthMm,
            input.heightMm,
            input.tareWeightGrams,
            input.maxWeightGrams,
            input.isActive,
            input.now,
          ],
        )
        : await client.query<BoxRow>(
          `INSERT INTO dropship.dropship_box_catalog
            (code, name, length_mm, width_mm, height_mm, tare_weight_grams,
             max_weight_grams, is_active, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
           ON CONFLICT (code) DO UPDATE
             SET name = EXCLUDED.name,
                 length_mm = EXCLUDED.length_mm,
                 width_mm = EXCLUDED.width_mm,
                 height_mm = EXCLUDED.height_mm,
                 tare_weight_grams = EXCLUDED.tare_weight_grams,
                 max_weight_grams = EXCLUDED.max_weight_grams,
                 is_active = EXCLUDED.is_active,
                 updated_at = EXCLUDED.updated_at
           RETURNING id, code, name, length_mm, width_mm, height_mm,
                     tare_weight_grams, max_weight_grams, is_active,
                     created_at, updated_at`,
          [
            input.code,
            input.name,
            input.lengthMm,
            input.widthMm,
            input.heightMm,
            input.tareWeightGrams,
            input.maxWeightGrams,
            input.isActive,
            input.now,
          ],
        );
      const box = mapBoxRow(requiredRow(result.rows[0], "Dropship box upsert did not return a row."));
      await completeAdminConfigCommand(client, command.commandId, "dropship_box_catalog", box.boxId, input.now);
      await recordAdminShippingAuditEvent(client, input, "dropship_box_catalog", box.boxId, "shipping_box_upserted", {
        code: box.code,
        isActive: box.isActive,
      });
      await client.query("COMMIT");
      return { record: box, idempotentReplay: false };
    } catch (error) {
      await rollbackQuietly(client);
      throw mapForeignKeyError(error);
    } finally {
      client.release();
    }
  }

  async upsertPackageProfile(
    input: NormalizedUpsertDropshipPackageProfileInput & DropshipShippingConfigCommandContext,
  ): Promise<DropshipShippingConfigMutationResult<DropshipPackageProfileConfigRecord>> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const command = await claimAdminConfigCommand(client, "shipping_package_profile_upserted", input);
      if (command.idempotentReplay) {
        const profile = await loadPackageProfileByIdWithClient(
          client,
          parseEntityId(command.entityId, "dropship_package_profiles"),
        );
        await client.query("COMMIT");
        return { record: profile, idempotentReplay: true };
      }

      await assertProductVariantExists(client, input.productVariantId);
      if (input.defaultBoxId !== null && input.defaultBoxId !== undefined) {
        await assertBoxExists(client, input.defaultBoxId);
      }

      const result = await client.query<PackageProfileRow>(
        `INSERT INTO dropship.dropship_package_profiles
          (product_variant_id, weight_grams, length_mm, width_mm, height_mm,
           ship_alone, default_carrier, default_service, default_box_id,
           max_units_per_package, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
         ON CONFLICT (product_variant_id) DO UPDATE
           SET weight_grams = EXCLUDED.weight_grams,
               length_mm = EXCLUDED.length_mm,
               width_mm = EXCLUDED.width_mm,
               height_mm = EXCLUDED.height_mm,
               ship_alone = EXCLUDED.ship_alone,
               default_carrier = EXCLUDED.default_carrier,
               default_service = EXCLUDED.default_service,
               default_box_id = EXCLUDED.default_box_id,
               max_units_per_package = EXCLUDED.max_units_per_package,
               is_active = EXCLUDED.is_active,
               updated_at = EXCLUDED.updated_at
         RETURNING id, product_variant_id, NULL::text AS product_sku,
                   NULL::text AS product_name, NULL::text AS variant_sku,
                   NULL::text AS variant_name, weight_grams, length_mm, width_mm,
                   height_mm, ship_alone, default_carrier, default_service,
                   default_box_id, max_units_per_package, is_active, created_at, updated_at`,
        [
          input.productVariantId,
          input.weightGrams,
          input.lengthMm,
          input.widthMm,
          input.heightMm,
          input.shipAlone,
          input.defaultCarrier,
          input.defaultService,
          input.defaultBoxId,
          input.maxUnitsPerPackage,
          input.isActive,
          input.now,
        ],
      );
      const profileId = requiredRow(result.rows[0], "Dropship package profile upsert did not return a row.").id;
      const profile = await loadPackageProfileByIdWithClient(client, profileId);
      await completeAdminConfigCommand(client, command.commandId, "dropship_package_profiles", profile.packageProfileId, input.now);
      await recordAdminShippingAuditEvent(
        client,
        input,
        "dropship_package_profiles",
        profile.packageProfileId,
        "shipping_package_profile_upserted",
        {
          productVariantId: profile.productVariantId,
          isActive: profile.isActive,
        },
      );
      await client.query("COMMIT");
      return { record: profile, idempotentReplay: false };
    } catch (error) {
      await rollbackQuietly(client);
      throw mapForeignKeyError(error);
    } finally {
      client.release();
    }
  }

  async upsertZoneRule(
    input: NormalizedUpsertDropshipZoneRuleInput & DropshipShippingConfigCommandContext,
  ): Promise<DropshipShippingConfigMutationResult<DropshipZoneRuleConfigRecord>> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const command = await claimAdminConfigCommand(client, "shipping_zone_rule_upserted", input);
      if (command.idempotentReplay) {
        const zoneRule = await loadZoneRuleByIdWithClient(client, parseEntityId(command.entityId, "dropship_zone_rules"));
        await client.query("COMMIT");
        return { record: zoneRule, idempotentReplay: true };
      }

      await assertWarehouseExists(client, input.originWarehouseId);
      const result = input.zoneRuleId
        ? await client.query<ZoneRuleRow>(
          `UPDATE dropship.dropship_zone_rules
           SET origin_warehouse_id = $2, destination_country = $3,
               destination_region = $4, postal_prefix = $5, zone = $6,
               priority = $7, is_active = $8, updated_at = $9
           WHERE id = $1
           RETURNING id, origin_warehouse_id, destination_country,
                     destination_region, postal_prefix, zone, priority,
                     is_active, created_at, updated_at`,
          [
            input.zoneRuleId,
            input.originWarehouseId,
            input.destinationCountry,
            input.destinationRegion,
            input.postalPrefix,
            input.zone,
            input.priority,
            input.isActive,
            input.now,
          ],
        )
        : await client.query<ZoneRuleRow>(
          `INSERT INTO dropship.dropship_zone_rules
            (origin_warehouse_id, destination_country, destination_region,
             postal_prefix, zone, priority, is_active, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
           RETURNING id, origin_warehouse_id, destination_country,
                     destination_region, postal_prefix, zone, priority,
                     is_active, created_at, updated_at`,
          [
            input.originWarehouseId,
            input.destinationCountry,
            input.destinationRegion,
            input.postalPrefix,
            input.zone,
            input.priority,
            input.isActive,
            input.now,
          ],
        );
      const zoneRule = mapZoneRuleRow(requiredRow(result.rows[0], "Dropship zone rule upsert did not return a row."));
      await completeAdminConfigCommand(client, command.commandId, "dropship_zone_rules", zoneRule.zoneRuleId, input.now);
      await recordAdminShippingAuditEvent(client, input, "dropship_zone_rules", zoneRule.zoneRuleId, "shipping_zone_rule_upserted", {
        originWarehouseId: zoneRule.originWarehouseId,
        zone: zoneRule.zone,
      });
      await client.query("COMMIT");
      return { record: zoneRule, idempotentReplay: false };
    } catch (error) {
      await rollbackQuietly(client);
      throw mapForeignKeyError(error);
    } finally {
      client.release();
    }
  }

  async createRateTable(
    input: NormalizedCreateDropshipRateTableInput & DropshipShippingConfigCommandContext,
  ): Promise<DropshipShippingConfigMutationResult<DropshipRateTableConfigRecord>> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const command = await claimAdminConfigCommand(client, "shipping_rate_table_created", input);
      if (command.idempotentReplay) {
        const table = await loadRateTableByIdWithClient(client, parseEntityId(command.entityId, "dropship_rate_tables"));
        await client.query("COMMIT");
        return { record: table, idempotentReplay: true };
      }

      await assertRateTableWarehousesExist(client, input.rows);
      const inserted = await client.query<RateTableRow>(
        `INSERT INTO dropship.dropship_rate_tables
          (carrier, service, currency, status, effective_from, effective_to, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         RETURNING id, carrier, service, currency, status, effective_from,
                   effective_to, metadata, created_at`,
        [
          input.carrier,
          input.service,
          input.currency,
          input.status,
          input.effectiveFrom,
          input.effectiveTo,
          JSON.stringify(input.metadata ?? {}),
          input.now,
        ],
      );
      const rateTableId = requiredRow(inserted.rows[0], "Dropship rate table insert did not return a row.").id;
      for (const row of input.rows) {
        await client.query(
          `INSERT INTO dropship.dropship_rate_table_rows
            (rate_table_id, warehouse_id, destination_zone, min_weight_grams,
             max_weight_grams, rate_cents, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            rateTableId,
            row.warehouseId ?? null,
            row.destinationZone,
            row.minWeightGrams,
            row.maxWeightGrams,
            row.rateCents,
            input.now,
          ],
        );
      }

      const rateTable = await loadRateTableByIdWithClient(client, rateTableId);
      await completeAdminConfigCommand(client, command.commandId, "dropship_rate_tables", rateTable.rateTableId, input.now);
      await recordAdminShippingAuditEvent(client, input, "dropship_rate_tables", rateTable.rateTableId, "shipping_rate_table_created", {
        carrier: rateTable.carrier,
        service: rateTable.service,
        rowCount: rateTable.rows.length,
      });
      await client.query("COMMIT");
      return { record: rateTable, idempotentReplay: false };
    } catch (error) {
      await rollbackQuietly(client);
      throw mapForeignKeyError(error);
    } finally {
      client.release();
    }
  }

  async createMarkupPolicy(
    input: NormalizedCreateDropshipMarkupPolicyInput & DropshipShippingConfigCommandContext,
  ): Promise<DropshipShippingConfigMutationResult<DropshipShippingMarkupPolicyRecord>> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const command = await claimAdminConfigCommand(client, "shipping_markup_policy_created", input);
      if (command.idempotentReplay) {
        const policy = await loadMarkupPolicyByIdWithClient(
          client,
          parseEntityId(command.entityId, "dropship_shipping_markup_config"),
        );
        await client.query("COMMIT");
        return { record: policy, idempotentReplay: true };
      }

      const inserted = await client.query<MarkupPolicyRow>(
        `INSERT INTO dropship.dropship_shipping_markup_config
          (name, markup_bps, fixed_markup_cents, min_markup_cents,
           max_markup_cents, is_active, effective_from, effective_to, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, name, markup_bps, fixed_markup_cents, min_markup_cents,
                   max_markup_cents, is_active, effective_from, effective_to, created_at`,
        [
          input.name,
          input.markupBps,
          input.fixedMarkupCents,
          input.minMarkupCents,
          input.maxMarkupCents,
          input.isActive,
          input.effectiveFrom,
          input.effectiveTo,
          input.now,
        ],
      );
      const policy = mapMarkupPolicyRow(requiredRow(inserted.rows[0], "Dropship markup policy insert did not return a row."));
      await completeAdminConfigCommand(client, command.commandId, "dropship_shipping_markup_config", policy.policyId, input.now);
      await recordAdminShippingAuditEvent(
        client,
        input,
        "dropship_shipping_markup_config",
        policy.policyId,
        "shipping_markup_policy_created",
        {
          markupBps: policy.markupBps,
          fixedMarkupCents: policy.fixedMarkupCents,
        },
      );
      await client.query("COMMIT");
      return { record: policy, idempotentReplay: false };
    } catch (error) {
      await rollbackQuietly(client);
      throw mapForeignKeyError(error);
    } finally {
      client.release();
    }
  }

  async createInsurancePolicy(
    input: NormalizedCreateDropshipInsurancePolicyInput & DropshipShippingConfigCommandContext,
  ): Promise<DropshipShippingConfigMutationResult<DropshipInsurancePoolPolicyRecord>> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const command = await claimAdminConfigCommand(client, "shipping_insurance_policy_created", input);
      if (command.idempotentReplay) {
        const policy = await loadInsurancePolicyByIdWithClient(
          client,
          parseEntityId(command.entityId, "dropship_insurance_pool_config"),
        );
        await client.query("COMMIT");
        return { record: policy, idempotentReplay: true };
      }

      const inserted = await client.query<InsurancePolicyRow>(
        `INSERT INTO dropship.dropship_insurance_pool_config
          (name, fee_bps, min_fee_cents, max_fee_cents, is_active,
           effective_from, effective_to, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, name, fee_bps, min_fee_cents, max_fee_cents,
                   is_active, effective_from, effective_to, created_at`,
        [
          input.name,
          input.feeBps,
          input.minFeeCents,
          input.maxFeeCents,
          input.isActive,
          input.effectiveFrom,
          input.effectiveTo,
          input.now,
        ],
      );
      const policy = mapInsurancePolicyRow(requiredRow(inserted.rows[0], "Dropship insurance policy insert did not return a row."));
      await completeAdminConfigCommand(client, command.commandId, "dropship_insurance_pool_config", policy.policyId, input.now);
      await recordAdminShippingAuditEvent(client, input, "dropship_insurance_pool_config", policy.policyId, "shipping_insurance_policy_created", {
        feeBps: policy.feeBps,
      });
      await client.query("COMMIT");
      return { record: policy, idempotentReplay: false };
    } catch (error) {
      await rollbackQuietly(client);
      throw mapForeignKeyError(error);
    } finally {
      client.release();
    }
  }
}

async function claimAdminConfigCommand(
  client: PoolClient,
  commandType: string,
  input: DropshipShippingConfigCommandContext,
): Promise<{
  commandId: number;
  entityId: string | null;
  idempotentReplay: boolean;
}> {
  const inserted = await client.query<{ id: number }>(
    `INSERT INTO dropship.dropship_admin_config_commands
      (command_type, idempotency_key, request_hash, entity_type,
       actor_type, actor_id, created_at)
     VALUES ($1, $2, $3, $1, $4, $5, $6)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      commandType,
      input.idempotencyKey,
      input.requestHash,
      input.actor.actorType,
      input.actor.actorId ?? null,
      input.now,
    ],
  );
  const insertedId = inserted.rows[0]?.id;
  if (insertedId) {
    return { commandId: insertedId, entityId: null, idempotentReplay: false };
  }

  const existing = await client.query<AdminCommandRow>(
    `SELECT id, command_type, request_hash, entity_type, entity_id
     FROM dropship.dropship_admin_config_commands
     WHERE idempotency_key = $1
     FOR UPDATE`,
    [input.idempotencyKey],
  );
  const row = requiredRow(existing.rows[0], "Dropship admin config idempotency row was not found after conflict.");
  if (row.command_type !== commandType || row.request_hash !== input.requestHash) {
    throw new DropshipError(
      "DROPSHIP_SHIPPING_CONFIG_IDEMPOTENCY_CONFLICT",
      "Dropship shipping config idempotency key was reused with a different request.",
      {
        commandType,
        idempotencyKey: input.idempotencyKey,
      },
    );
  }
  if (!row.entity_id) {
    throw new DropshipError(
      "DROPSHIP_SHIPPING_CONFIG_COMMAND_INCOMPLETE",
      "Dropship shipping config command replay is incomplete.",
      {
        commandType,
        idempotencyKey: input.idempotencyKey,
      },
    );
  }
  return { commandId: row.id, entityId: row.entity_id, idempotentReplay: true };
}

async function completeAdminConfigCommand(
  client: PoolClient,
  commandId: number,
  entityType: string,
  entityId: number,
  now: Date,
): Promise<void> {
  await client.query(
    `UPDATE dropship.dropship_admin_config_commands
     SET entity_type = $2, entity_id = $3, completed_at = $4
     WHERE id = $1`,
    [commandId, entityType, String(entityId), now],
  );
}

async function listBoxesWithClient(client: PoolClient): Promise<DropshipBoxConfigRecord[]> {
  const result = await client.query<BoxRow>(
    `SELECT id, code, name, length_mm, width_mm, height_mm, tare_weight_grams,
            max_weight_grams, is_active, created_at, updated_at
     FROM dropship.dropship_box_catalog
     ORDER BY is_active DESC, code ASC`,
  );
  return result.rows.map(mapBoxRow);
}

async function listPackageProfilesWithClient(
  client: PoolClient,
  input: Pick<ListDropshipShippingConfigInput, "search" | "packageProfileLimit">,
): Promise<DropshipPackageProfileConfigRecord[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (input.search) {
    params.push(`%${input.search}%`);
    where.push(`(
      p.sku ILIKE $${params.length}
      OR p.name ILIKE $${params.length}
      OR pv.sku ILIKE $${params.length}
      OR pv.name ILIKE $${params.length}
    )`);
  }
  params.push(input.packageProfileLimit);
  const result = await client.query<PackageProfileRow>(
    `SELECT pp.id, pp.product_variant_id, p.sku AS product_sku,
            p.name AS product_name, pv.sku AS variant_sku, pv.name AS variant_name,
            pp.weight_grams, pp.length_mm, pp.width_mm, pp.height_mm,
            pp.ship_alone, pp.default_carrier, pp.default_service,
            pp.default_box_id, pp.max_units_per_package, pp.is_active,
            pp.created_at, pp.updated_at
     FROM dropship.dropship_package_profiles pp
     INNER JOIN catalog.product_variants pv ON pv.id = pp.product_variant_id
     INNER JOIN catalog.products p ON p.id = pv.product_id
     ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY pp.is_active DESC, p.name ASC, pv.position ASC, pv.name ASC
     LIMIT $${params.length}`,
    params,
  );
  return result.rows.map(mapPackageProfileRow);
}

async function listZoneRulesWithClient(client: PoolClient): Promise<DropshipZoneRuleConfigRecord[]> {
  const result = await client.query<ZoneRuleRow>(
    `SELECT id, origin_warehouse_id, destination_country, destination_region,
            postal_prefix, zone, priority, is_active, created_at, updated_at
     FROM dropship.dropship_zone_rules
     ORDER BY is_active DESC, origin_warehouse_id ASC, priority DESC,
              destination_country ASC, postal_prefix ASC NULLS LAST, id ASC`,
  );
  return result.rows.map(mapZoneRuleRow);
}

async function listRateTablesWithClient(
  client: PoolClient,
  limit: number,
): Promise<DropshipRateTableConfigRecord[]> {
  const tableResult = await client.query<RateTableRow>(
    `SELECT id, carrier, service, currency, status, effective_from,
            effective_to, metadata, created_at
     FROM dropship.dropship_rate_tables
     ORDER BY effective_from DESC, id DESC
     LIMIT $1`,
    [limit],
  );
  const rateTables = tableResult.rows.map(mapRateTableRow);
  if (rateTables.length === 0) {
    return [];
  }

  const rowResult = await client.query<RateTableLineRow>(
    `SELECT id, rate_table_id, warehouse_id, destination_zone,
            min_weight_grams, max_weight_grams, rate_cents, created_at
     FROM dropship.dropship_rate_table_rows
     WHERE rate_table_id = ANY($1::int[])
     ORDER BY rate_table_id DESC, destination_zone ASC,
              min_weight_grams ASC, warehouse_id ASC NULLS LAST`,
    [rateTables.map((table) => table.rateTableId)],
  );
  const rowsByTableId = new Map<number, DropshipRateTableRowConfigRecord[]>();
  for (const row of rowResult.rows) {
    const mapped = mapRateTableLineRow(row);
    const existing = rowsByTableId.get(mapped.rateTableId) ?? [];
    existing.push(mapped);
    rowsByTableId.set(mapped.rateTableId, existing);
  }
  return rateTables.map((table) => ({
    ...table,
    rows: rowsByTableId.get(table.rateTableId) ?? [],
  }));
}

async function loadBoxByIdWithClient(client: PoolClient, boxId: number): Promise<DropshipBoxConfigRecord> {
  const result = await client.query<BoxRow>(
    `SELECT id, code, name, length_mm, width_mm, height_mm, tare_weight_grams,
            max_weight_grams, is_active, created_at, updated_at
     FROM dropship.dropship_box_catalog
     WHERE id = $1`,
    [boxId],
  );
  return mapBoxRow(requiredRow(result.rows[0], "Dropship box was not found."));
}

async function loadPackageProfileByIdWithClient(
  client: PoolClient,
  packageProfileId: number,
): Promise<DropshipPackageProfileConfigRecord> {
  const result = await client.query<PackageProfileRow>(
    `SELECT pp.id, pp.product_variant_id, p.sku AS product_sku,
            p.name AS product_name, pv.sku AS variant_sku, pv.name AS variant_name,
            pp.weight_grams, pp.length_mm, pp.width_mm, pp.height_mm,
            pp.ship_alone, pp.default_carrier, pp.default_service,
            pp.default_box_id, pp.max_units_per_package, pp.is_active,
            pp.created_at, pp.updated_at
     FROM dropship.dropship_package_profiles pp
     INNER JOIN catalog.product_variants pv ON pv.id = pp.product_variant_id
     INNER JOIN catalog.products p ON p.id = pv.product_id
     WHERE pp.id = $1`,
    [packageProfileId],
  );
  return mapPackageProfileRow(requiredRow(result.rows[0], "Dropship package profile was not found."));
}

async function loadZoneRuleByIdWithClient(
  client: PoolClient,
  zoneRuleId: number,
): Promise<DropshipZoneRuleConfigRecord> {
  const result = await client.query<ZoneRuleRow>(
    `SELECT id, origin_warehouse_id, destination_country, destination_region,
            postal_prefix, zone, priority, is_active, created_at, updated_at
     FROM dropship.dropship_zone_rules
     WHERE id = $1`,
    [zoneRuleId],
  );
  return mapZoneRuleRow(requiredRow(result.rows[0], "Dropship zone rule was not found."));
}

async function loadRateTableByIdWithClient(
  client: PoolClient,
  rateTableId: number,
): Promise<DropshipRateTableConfigRecord> {
  const result = await client.query<RateTableRow>(
    `SELECT id, carrier, service, currency, status, effective_from,
            effective_to, metadata, created_at
     FROM dropship.dropship_rate_tables
     WHERE id = $1`,
    [rateTableId],
  );
  const table = mapRateTableRow(requiredRow(result.rows[0], "Dropship rate table was not found."));
  const rows = await client.query<RateTableLineRow>(
    `SELECT id, rate_table_id, warehouse_id, destination_zone,
            min_weight_grams, max_weight_grams, rate_cents, created_at
     FROM dropship.dropship_rate_table_rows
     WHERE rate_table_id = $1
     ORDER BY destination_zone ASC, min_weight_grams ASC, warehouse_id ASC NULLS LAST`,
    [rateTableId],
  );
  return { ...table, rows: rows.rows.map(mapRateTableLineRow) };
}

async function loadMarkupPolicyByIdWithClient(
  client: PoolClient,
  policyId: number,
): Promise<DropshipShippingMarkupPolicyRecord> {
  const result = await client.query<MarkupPolicyRow>(
    `SELECT id, name, markup_bps, fixed_markup_cents, min_markup_cents,
            max_markup_cents, is_active, effective_from, effective_to, created_at
     FROM dropship.dropship_shipping_markup_config
     WHERE id = $1`,
    [policyId],
  );
  return mapMarkupPolicyRow(requiredRow(result.rows[0], "Dropship shipping markup policy was not found."));
}

async function loadInsurancePolicyByIdWithClient(
  client: PoolClient,
  policyId: number,
): Promise<DropshipInsurancePoolPolicyRecord> {
  const result = await client.query<InsurancePolicyRow>(
    `SELECT id, name, fee_bps, min_fee_cents, max_fee_cents,
            is_active, effective_from, effective_to, created_at
     FROM dropship.dropship_insurance_pool_config
     WHERE id = $1`,
    [policyId],
  );
  return mapInsurancePolicyRow(requiredRow(result.rows[0], "Dropship insurance pool policy was not found."));
}

async function loadActiveMarkupPolicyWithClient(
  client: PoolClient,
  at: Date,
): Promise<DropshipShippingMarkupPolicyRecord | null> {
  const result = await client.query<MarkupPolicyRow>(
    `SELECT id, name, markup_bps, fixed_markup_cents, min_markup_cents,
            max_markup_cents, is_active, effective_from, effective_to, created_at
     FROM dropship.dropship_shipping_markup_config
     WHERE is_active = true
       AND effective_from <= $1
       AND (effective_to IS NULL OR effective_to > $1)
     ORDER BY effective_from DESC, id DESC
     LIMIT 1`,
    [at],
  );
  return result.rows[0] ? mapMarkupPolicyRow(result.rows[0]) : null;
}

async function loadActiveInsurancePolicyWithClient(
  client: PoolClient,
  at: Date,
): Promise<DropshipInsurancePoolPolicyRecord | null> {
  const result = await client.query<InsurancePolicyRow>(
    `SELECT id, name, fee_bps, min_fee_cents, max_fee_cents,
            is_active, effective_from, effective_to, created_at
     FROM dropship.dropship_insurance_pool_config
     WHERE is_active = true
       AND effective_from <= $1
       AND (effective_to IS NULL OR effective_to > $1)
     ORDER BY effective_from DESC, id DESC
     LIMIT 1`,
    [at],
  );
  return result.rows[0] ? mapInsurancePolicyRow(result.rows[0]) : null;
}

async function assertProductVariantExists(client: PoolClient, productVariantId: number): Promise<void> {
  const result = await client.query<{ id: number }>(
    "SELECT id FROM catalog.product_variants WHERE id = $1 LIMIT 1",
    [productVariantId],
  );
  if (!result.rows[0]) {
    throw new DropshipError("DROPSHIP_PRODUCT_VARIANT_NOT_FOUND", "Product variant was not found.", {
      productVariantId,
    });
  }
}

async function assertBoxExists(client: PoolClient, boxId: number): Promise<void> {
  const result = await client.query<{ id: number }>(
    "SELECT id FROM dropship.dropship_box_catalog WHERE id = $1 LIMIT 1",
    [boxId],
  );
  if (!result.rows[0]) {
    throw new DropshipError("DROPSHIP_SHIPPING_BOX_NOT_FOUND", "Dropship box was not found.", { boxId });
  }
}

async function assertWarehouseExists(client: PoolClient, warehouseId: number): Promise<void> {
  const result = await client.query<{ id: number }>(
    "SELECT id FROM warehouse.warehouses WHERE id = $1 LIMIT 1",
    [warehouseId],
  );
  if (!result.rows[0]) {
    throw new DropshipError("DROPSHIP_WAREHOUSE_NOT_FOUND", "Warehouse was not found.", { warehouseId });
  }
}

async function assertRateTableWarehousesExist(
  client: PoolClient,
  rows: CreateDropshipRateTableInput["rows"],
): Promise<void> {
  const warehouseIds = [...new Set(rows.map((row) => row.warehouseId).filter((value): value is number => Number.isInteger(value)))];
  if (warehouseIds.length === 0) {
    return;
  }
  const result = await client.query<{ id: number }>(
    "SELECT id FROM warehouse.warehouses WHERE id = ANY($1::int[])",
    [warehouseIds],
  );
  const found = new Set(result.rows.map((row) => row.id));
  const missing = warehouseIds.filter((warehouseId) => !found.has(warehouseId));
  if (missing.length > 0) {
    throw new DropshipError("DROPSHIP_WAREHOUSE_NOT_FOUND", "One or more warehouses were not found.", {
      warehouseIds: missing,
    });
  }
}

async function recordAdminShippingAuditEvent(
  client: PoolClient,
  input: DropshipShippingConfigCommandContext,
  entityType: string,
  entityId: number,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
      (entity_type, entity_id, event_type, actor_type, actor_id,
       severity, payload, created_at)
     VALUES ($1, $2, $3, $4, $5, 'info', $6::jsonb, $7)`,
    [
      entityType,
      String(entityId),
      eventType,
      input.actor.actorType,
      input.actor.actorId ?? null,
      JSON.stringify({
        ...payload,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
      }),
      input.now,
    ],
  );
}

function mapBoxRow(row: BoxRow): DropshipBoxConfigRecord {
  return {
    boxId: row.id,
    code: row.code,
    name: row.name,
    lengthMm: row.length_mm,
    widthMm: row.width_mm,
    heightMm: row.height_mm,
    tareWeightGrams: row.tare_weight_grams,
    maxWeightGrams: row.max_weight_grams,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPackageProfileRow(row: PackageProfileRow): DropshipPackageProfileConfigRecord {
  return {
    packageProfileId: row.id,
    productVariantId: row.product_variant_id,
    productSku: row.product_sku,
    productName: row.product_name,
    variantSku: row.variant_sku,
    variantName: row.variant_name,
    weightGrams: row.weight_grams,
    lengthMm: row.length_mm,
    widthMm: row.width_mm,
    heightMm: row.height_mm,
    shipAlone: row.ship_alone,
    defaultCarrier: row.default_carrier,
    defaultService: row.default_service,
    defaultBoxId: row.default_box_id,
    maxUnitsPerPackage: row.max_units_per_package,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapZoneRuleRow(row: ZoneRuleRow): DropshipZoneRuleConfigRecord {
  return {
    zoneRuleId: row.id,
    originWarehouseId: row.origin_warehouse_id,
    destinationCountry: row.destination_country,
    destinationRegion: row.destination_region,
    postalPrefix: row.postal_prefix,
    zone: row.zone,
    priority: row.priority,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRateTableRow(row: RateTableRow): DropshipRateTableConfigRecord {
  return {
    rateTableId: row.id,
    carrier: row.carrier,
    service: row.service,
    currency: row.currency,
    status: row.status,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    metadata: row.metadata,
    createdAt: row.created_at,
    rows: [],
  };
}

function mapRateTableLineRow(row: RateTableLineRow): DropshipRateTableRowConfigRecord {
  return {
    rateTableRowId: row.id,
    rateTableId: row.rate_table_id,
    warehouseId: row.warehouse_id,
    destinationZone: row.destination_zone,
    minWeightGrams: row.min_weight_grams,
    maxWeightGrams: row.max_weight_grams,
    rateCents: Number(row.rate_cents),
    createdAt: row.created_at,
  };
}

function mapMarkupPolicyRow(row: MarkupPolicyRow): DropshipShippingMarkupPolicyRecord {
  return {
    policyId: row.id,
    name: row.name,
    markupBps: row.markup_bps,
    fixedMarkupCents: Number(row.fixed_markup_cents),
    minMarkupCents: row.min_markup_cents === null ? null : Number(row.min_markup_cents),
    maxMarkupCents: row.max_markup_cents === null ? null : Number(row.max_markup_cents),
    isActive: row.is_active,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    createdAt: row.created_at,
  };
}

function mapInsurancePolicyRow(row: InsurancePolicyRow): DropshipInsurancePoolPolicyRecord {
  return {
    policyId: row.id,
    name: row.name,
    feeBps: row.fee_bps,
    minFeeCents: row.min_fee_cents === null ? null : Number(row.min_fee_cents),
    maxFeeCents: row.max_fee_cents === null ? null : Number(row.max_fee_cents),
    isActive: row.is_active,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    createdAt: row.created_at,
  };
}

function parseEntityId(value: string | null, entityType: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new DropshipError(
      "DROPSHIP_SHIPPING_CONFIG_COMMAND_INCOMPLETE",
      "Dropship shipping config replay entity id is invalid.",
      { entityType, entityId: value },
    );
  }
  return parsed;
}

function requiredRow<T>(row: T | undefined, message: string): T {
  if (!row) {
    throw new Error(message);
  }
  return row;
}

function mapForeignKeyError(error: unknown): unknown {
  if (!error || typeof error !== "object") {
    return error;
  }
  const code = (error as { code?: string }).code;
  if (code === "23503") {
    return new DropshipError(
      "DROPSHIP_SHIPPING_CONFIG_REFERENCE_NOT_FOUND",
      "Dropship shipping configuration references a missing record.",
      { detail: (error as { detail?: string }).detail },
    );
  }
  return error;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original failure.
  }
}
