import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { DropshipError } from "../domain/errors";
import type {
  DropshipSelectionAtpRepository,
  DropshipVendorCatalogCandidate,
  DropshipVendorProfile,
  DropshipVendorSelectionRuleRecord,
  DropshipVendorVariantOverrideRecord,
  NormalizedDropshipVendorSelectionRule,
  ReplaceDropshipVendorSelectionRulesRepositoryInput,
  ReplaceDropshipVendorSelectionRulesRepositoryResult,
} from "../application/dropship-selection-atp-service";
import type {
  ListDropshipVendorSelectionRulesInput,
  PreviewDropshipVendorCatalogInput,
} from "../application/dropship-selection-dtos";
import type { DropshipCatalogExposureRule } from "../domain/catalog-exposure";

interface VendorRow {
  id: number;
  member_id: string;
  status: string;
  entitlement_status: string;
}

interface CatalogRuleRow {
  id: number;
  scope_type: string;
  action: string;
  product_line_id: number | null;
  product_id: number | null;
  product_variant_id: number | null;
  category: string | null;
  starts_at: Date | null;
  ends_at: Date | null;
}

interface SelectionRuleRow {
  id: number;
  revision_id: number | null;
  vendor_id: number;
  scope_type: string;
  action: string;
  product_line_id: number | null;
  product_id: number | null;
  product_variant_id: number | null;
  category: string | null;
  auto_connect_new_skus: boolean;
  auto_list_new_skus: boolean;
  priority: number;
  is_active: boolean;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

interface VendorCatalogCandidateRow {
  product_id: number;
  product_sku: string | null;
  product_name: string;
  product_category: string | null;
  product_is_active: boolean;
  product_variant_id: number;
  variant_sku: string | null;
  variant_name: string;
  units_per_variant: number;
  variant_is_active: boolean;
  product_line_ids: number[] | null;
  product_line_names: string[] | null;
}

interface VariantOverrideRow {
  id: number;
  vendor_id: number;
  product_variant_id: number;
  enabled_override: boolean | null;
  marketplace_quantity_cap: number | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

export class PgDropshipSelectionAtpRepository implements DropshipSelectionAtpRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async findVendorByMemberId(memberId: string): Promise<DropshipVendorProfile | null> {
    const client = await this.dbPool.connect();
    try {
      const result = await client.query<VendorRow>(
        `SELECT id, member_id, status, entitlement_status
         FROM dropship.dropship_vendors
         WHERE member_id::text = $1
         LIMIT 1`,
        [memberId],
      );
      const row = result.rows[0];
      if (!row) {
        return null;
      }
      return {
        vendorId: row.id,
        memberId: row.member_id,
        status: row.status,
        entitlementStatus: row.entitlement_status,
      };
    } finally {
      client.release();
    }
  }

  async listCatalogExposureRules(): Promise<DropshipCatalogExposureRule[]> {
    const client = await this.dbPool.connect();
    try {
      const result = await client.query<CatalogRuleRow>(
        `SELECT id, scope_type, action, product_line_id, product_id,
                product_variant_id, category, starts_at, ends_at
         FROM dropship.dropship_catalog_rules
         WHERE is_active = true
         ORDER BY priority DESC, id ASC`,
      );
      return result.rows.map(mapCatalogExposureRuleRow);
    } finally {
      client.release();
    }
  }

  async listSelectionRules(
    input: ListDropshipVendorSelectionRulesInput,
  ): Promise<DropshipVendorSelectionRuleRecord[]> {
    const client = await this.dbPool.connect();
    try {
      return await listSelectionRulesWithClient(client, input);
    } finally {
      client.release();
    }
  }

  async replaceSelectionRules(
    input: ReplaceDropshipVendorSelectionRulesRepositoryInput,
  ): Promise<ReplaceDropshipVendorSelectionRulesRepositoryResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('dropship_vendor_selection_rules'), $1::integer)", [
        input.vendorId,
      ]);

      const existingRevision = await client.query<{
        id: number;
        request_hash: string;
      }>(
        `SELECT id, request_hash
         FROM dropship.dropship_vendor_selection_rule_set_revisions
         WHERE vendor_id = $1 AND idempotency_key = $2
         FOR UPDATE`,
        [input.vendorId, input.idempotencyKey],
      );

      if (existingRevision.rows[0]) {
        if (existingRevision.rows[0].request_hash !== input.requestHash) {
          throw new DropshipError(
            "DROPSHIP_IDEMPOTENCY_CONFLICT",
            "Dropship vendor selection idempotency key was reused with a different request.",
            { vendorId: input.vendorId },
          );
        }

        const rules = await listSelectionRulesWithClient(client, {
          vendorId: input.vendorId,
          includeInactive: false,
        });
        await client.query("COMMIT");
        return {
          revisionId: existingRevision.rows[0].id,
          idempotentReplay: true,
          rules,
        };
      }

      const beforeRules = await listSelectionRulesWithClient(client, {
        vendorId: input.vendorId,
        includeInactive: false,
      });
      const revision = await client.query<{ id: number }>(
        `INSERT INTO dropship.dropship_vendor_selection_rule_set_revisions
          (vendor_id, idempotency_key, request_hash, actor_type, actor_id, rule_count, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          input.vendorId,
          input.idempotencyKey,
          input.requestHash,
          input.actor.actorType,
          input.actor.actorId ?? null,
          input.rules.length,
          input.now,
        ],
      );
      const revisionId = revision.rows[0]?.id;
      if (!revisionId) {
        throw new Error("Dropship vendor selection revision insert did not return an id.");
      }

      await client.query(
        `UPDATE dropship.dropship_vendor_selection_rules
         SET is_active = false, updated_at = $2
         WHERE vendor_id = $1 AND is_active = true`,
        [input.vendorId, input.now],
      );

      for (const rule of input.rules) {
        await insertSelectionRule(client, input.vendorId, revisionId, rule, input.now);
      }

      const afterRules = await listSelectionRulesWithClient(client, {
        vendorId: input.vendorId,
        includeInactive: false,
      });
      await recordSelectionAuditEvent(client, {
        vendorId: input.vendorId,
        revisionId,
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
        beforeRules,
        afterRules,
        now: input.now,
      });
      await client.query("COMMIT");

      return {
        revisionId,
        idempotentReplay: false,
        rules: afterRules,
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async listVendorCatalogCandidates(
    input: PreviewDropshipVendorCatalogInput,
  ): Promise<DropshipVendorCatalogCandidate[]> {
    const client = await this.dbPool.connect();
    try {
      const params: unknown[] = [];
      const where = ["p.is_active = true", "pv.is_active = true"];

      if (input.search) {
        params.push(`%${input.search}%`);
        where.push(`(
          p.sku ILIKE $${params.length}
          OR pv.sku ILIKE $${params.length}
          OR p.name ILIKE $${params.length}
          OR pv.name ILIKE $${params.length}
        )`);
      }

      if (input.category) {
        params.push(input.category);
        where.push(`LOWER(p.category) = LOWER($${params.length})`);
      }

      if (input.productLineId) {
        params.push(input.productLineId);
        where.push(`EXISTS (
          SELECT 1
          FROM catalog.product_line_products plp_filter
          WHERE plp_filter.product_id = p.id
            AND plp_filter.product_line_id = $${params.length}
        )`);
      }

      const result = await client.query<VendorCatalogCandidateRow>(
        `SELECT
           p.id AS product_id,
           p.sku AS product_sku,
           p.name AS product_name,
           p.category AS product_category,
           p.is_active AS product_is_active,
           pv.id AS product_variant_id,
           pv.sku AS variant_sku,
           pv.name AS variant_name,
           pv.units_per_variant,
           pv.is_active AS variant_is_active,
           ARRAY_REMOVE(ARRAY_AGG(DISTINCT plp.product_line_id), NULL) AS product_line_ids,
           ARRAY_REMOVE(ARRAY_AGG(DISTINCT pl.name), NULL) AS product_line_names
         FROM catalog.product_variants pv
         INNER JOIN catalog.products p ON p.id = pv.product_id
         LEFT JOIN catalog.product_line_products plp ON plp.product_id = p.id
         LEFT JOIN catalog.product_lines pl ON pl.id = plp.product_line_id
         WHERE ${where.join(" AND ")}
         GROUP BY p.id, p.sku, p.name, p.category, p.is_active,
                  pv.id, pv.sku, pv.name, pv.units_per_variant, pv.is_active, pv.position
         ORDER BY p.name ASC, pv.position ASC, pv.name ASC`,
        params,
      );

      return result.rows.map(mapVendorCatalogCandidateRow);
    } finally {
      client.release();
    }
  }

  async listVariantOverrides(input: {
    vendorId: number;
    productVariantIds: readonly number[];
  }): Promise<DropshipVendorVariantOverrideRecord[]> {
    if (input.productVariantIds.length === 0) {
      return [];
    }

    const client = await this.dbPool.connect();
    try {
      const result = await client.query<VariantOverrideRow>(
        `SELECT id, vendor_id, product_variant_id, enabled_override, marketplace_quantity_cap,
                notes, created_at, updated_at
         FROM dropship.dropship_vendor_variant_overrides
         WHERE vendor_id = $1
           AND product_variant_id = ANY($2::int[])`,
        [input.vendorId, input.productVariantIds],
      );
      return result.rows.map(mapVariantOverrideRow);
    } finally {
      client.release();
    }
  }
}

async function listSelectionRulesWithClient(
  client: PoolClient,
  input: ListDropshipVendorSelectionRulesInput,
): Promise<DropshipVendorSelectionRuleRecord[]> {
  const result = await client.query<SelectionRuleRow>(
    `SELECT id, revision_id, vendor_id, scope_type, action, product_line_id,
            product_id, product_variant_id, category, auto_connect_new_skus,
            auto_list_new_skus, priority, is_active, metadata, created_at, updated_at
     FROM dropship.dropship_vendor_selection_rules
     WHERE vendor_id = $1
       AND ($2::boolean = true OR is_active = true)
     ORDER BY is_active DESC, priority DESC, id ASC`,
    [input.vendorId, input.includeInactive],
  );
  return result.rows.map(mapSelectionRuleRow);
}

async function insertSelectionRule(
  client: PoolClient,
  vendorId: number,
  revisionId: number,
  rule: NormalizedDropshipVendorSelectionRule,
  now: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_vendor_selection_rules
      (revision_id, vendor_id, scope_type, action, product_line_id, product_id,
       product_variant_id, category, auto_connect_new_skus, auto_list_new_skus,
       priority, is_active, metadata, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true, $12::jsonb, $13, $13)`,
    [
      revisionId,
      vendorId,
      rule.scopeType,
      rule.action,
      rule.productLineId,
      rule.productId,
      rule.productVariantId,
      rule.category,
      rule.autoConnectNewSkus,
      rule.autoListNewSkus,
      rule.priority,
      JSON.stringify(rule.metadata),
      now,
    ],
  );
}

async function recordSelectionAuditEvent(
  client: PoolClient,
  input: {
    vendorId: number;
    revisionId: number;
    actorType: "vendor" | "admin" | "system";
    actorId?: string;
    beforeRules: DropshipVendorSelectionRuleRecord[];
    afterRules: DropshipVendorSelectionRuleRecord[];
    now: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
      (vendor_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, 'dropship_vendor_selection_ruleset', $2, 'vendor_selection_rules_replaced',
             $3, $4, 'info', $5::jsonb, $6)`,
    [
      input.vendorId,
      String(input.revisionId),
      input.actorType,
      input.actorId ?? null,
      JSON.stringify({
        beforeRules: input.beforeRules.map(serializeSelectionRuleForAudit),
        afterRules: input.afterRules.map(serializeSelectionRuleForAudit),
      }),
      input.now,
    ],
  );
}

function mapCatalogExposureRuleRow(row: CatalogRuleRow): DropshipCatalogExposureRule {
  return {
    id: row.id,
    scopeType: row.scope_type as DropshipCatalogExposureRule["scopeType"],
    action: row.action as DropshipCatalogExposureRule["action"],
    productLineId: row.product_line_id,
    productId: row.product_id,
    productVariantId: row.product_variant_id,
    category: row.category,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
  };
}

function mapSelectionRuleRow(row: SelectionRuleRow): DropshipVendorSelectionRuleRecord {
  return {
    id: row.id,
    revisionId: row.revision_id,
    vendorId: row.vendor_id,
    scopeType: row.scope_type as DropshipVendorSelectionRuleRecord["scopeType"],
    action: row.action as DropshipVendorSelectionRuleRecord["action"],
    productLineId: row.product_line_id,
    productId: row.product_id,
    productVariantId: row.product_variant_id,
    category: row.category,
    autoConnectNewSkus: row.auto_connect_new_skus,
    autoListNewSkus: row.auto_list_new_skus,
    priority: row.priority,
    isActive: row.is_active,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapVendorCatalogCandidateRow(row: VendorCatalogCandidateRow): DropshipVendorCatalogCandidate {
  return {
    productId: row.product_id,
    productSku: row.product_sku,
    productName: row.product_name,
    productVariantId: row.product_variant_id,
    variantSku: row.variant_sku,
    variantName: row.variant_name,
    unitsPerVariant: Math.max(1, Number(row.units_per_variant)),
    category: row.product_category,
    productLineIds: row.product_line_ids ?? [],
    productLineNames: row.product_line_names ?? [],
    productIsActive: row.product_is_active,
    variantIsActive: row.variant_is_active,
  };
}

function mapVariantOverrideRow(row: VariantOverrideRow): DropshipVendorVariantOverrideRecord {
  return {
    id: row.id,
    vendorId: row.vendor_id,
    productVariantId: row.product_variant_id,
    enabledOverride: row.enabled_override,
    marketplaceQuantityCap: row.marketplace_quantity_cap,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeSelectionRuleForAudit(rule: DropshipVendorSelectionRuleRecord): Record<string, unknown> {
  return {
    id: rule.id,
    revisionId: rule.revisionId,
    vendorId: rule.vendorId,
    scopeType: rule.scopeType,
    action: rule.action,
    productLineId: rule.productLineId,
    productId: rule.productId,
    productVariantId: rule.productVariantId,
    category: rule.category,
    autoConnectNewSkus: rule.autoConnectNewSkus,
    autoListNewSkus: rule.autoListNewSkus,
    priority: rule.priority,
    metadata: rule.metadata,
  };
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original failure.
  }
}
