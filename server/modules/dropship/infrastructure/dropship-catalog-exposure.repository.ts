import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { DropshipError } from "../domain/errors";
import type {
  DropshipCatalogExposureRepository,
  DropshipCatalogExposureRuleRecord,
  DropshipCatalogPreviewCandidate,
  NormalizedDropshipCatalogExposureRule,
  ReplaceDropshipCatalogExposureRulesRepositoryInput,
  ReplaceDropshipCatalogExposureRulesRepositoryResult,
} from "../application/dropship-catalog-exposure-service";
import type {
  ListDropshipCatalogExposureRulesInput,
  PreviewDropshipCatalogExposureInput,
} from "../application/dropship-catalog-dtos";

interface CatalogRuleRow {
  id: number;
  revision_id: number | null;
  scope_type: string;
  action: string;
  product_line_id: number | null;
  product_id: number | null;
  product_variant_id: number | null;
  category: string | null;
  priority: number;
  is_active: boolean;
  starts_at: Date | null;
  ends_at: Date | null;
  notes: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

interface CatalogPreviewRow {
  product_id: number;
  product_sku: string | null;
  product_name: string;
  product_category: string | null;
  product_is_active: boolean;
  product_variant_id: number;
  variant_sku: string | null;
  variant_name: string;
  variant_is_active: boolean;
  product_line_ids: number[] | null;
  product_line_names: string[] | null;
}

export class PgDropshipCatalogExposureRepository implements DropshipCatalogExposureRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async listRules(input: ListDropshipCatalogExposureRulesInput): Promise<DropshipCatalogExposureRuleRecord[]> {
    const client = await this.dbPool.connect();
    try {
      const result = await client.query<CatalogRuleRow>(
        `SELECT id, revision_id, scope_type, action, product_line_id, product_id,
                product_variant_id, category, priority, is_active, starts_at, ends_at,
                notes, metadata, created_at, updated_at
         FROM dropship.dropship_catalog_rules
         WHERE ($1::boolean = true OR is_active = true)
         ORDER BY is_active DESC, priority DESC, id ASC`,
        [input.includeInactive],
      );
      return result.rows.map(mapCatalogRuleRow);
    } finally {
      client.release();
    }
  }

  async replaceRules(
    input: ReplaceDropshipCatalogExposureRulesRepositoryInput,
  ): Promise<ReplaceDropshipCatalogExposureRulesRepositoryResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("LOCK TABLE dropship.dropship_catalog_rules IN EXCLUSIVE MODE");

      const existingRevision = await client.query<{
        id: number;
        request_hash: string;
      }>(
        `SELECT id, request_hash
         FROM dropship.dropship_catalog_rule_set_revisions
         WHERE idempotency_key = $1
         FOR UPDATE`,
        [input.idempotencyKey],
      );

      if (existingRevision.rows[0]) {
        if (existingRevision.rows[0].request_hash !== input.requestHash) {
          throw new DropshipError(
            "DROPSHIP_IDEMPOTENCY_CONFLICT",
            "Dropship catalog exposure idempotency key was reused with a different request.",
            { idempotencyKey: input.idempotencyKey },
          );
        }

        const rules = await listRulesWithClient(client, { includeInactive: false });
        await client.query("COMMIT");
        return {
          revisionId: existingRevision.rows[0].id,
          idempotentReplay: true,
          rules,
        };
      }

      const beforeRules = await listRulesWithClient(client, { includeInactive: false });
      const revision = await client.query<{ id: number }>(
        `INSERT INTO dropship.dropship_catalog_rule_set_revisions
          (idempotency_key, request_hash, actor_type, actor_id, rule_count, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
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
        throw new Error("Dropship catalog exposure revision insert did not return an id.");
      }

      await client.query(
        `UPDATE dropship.dropship_catalog_rules
         SET is_active = false, updated_at = $1
         WHERE is_active = true`,
        [input.now],
      );

      for (const rule of input.rules) {
        await insertRule(client, revisionId, rule, input.now);
      }

      const afterRules = await listRulesWithClient(client, { includeInactive: false });
      await recordAuditEvent(client, {
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

  async listPreviewCandidates(
    input: PreviewDropshipCatalogExposureInput,
  ): Promise<DropshipCatalogPreviewCandidate[]> {
    const client = await this.dbPool.connect();
    try {
      const params: unknown[] = [];
      const where: string[] = [];

      if (!input.includeInactiveCatalog) {
        where.push("p.is_active = true");
        where.push("pv.is_active = true");
      }

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

      const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
      const result = await client.query<CatalogPreviewRow>(
        `SELECT
           p.id AS product_id,
           p.sku AS product_sku,
           p.name AS product_name,
           p.category AS product_category,
           p.is_active AS product_is_active,
           pv.id AS product_variant_id,
           pv.sku AS variant_sku,
           pv.name AS variant_name,
           pv.is_active AS variant_is_active,
           ARRAY_REMOVE(ARRAY_AGG(DISTINCT plp.product_line_id), NULL) AS product_line_ids,
           ARRAY_REMOVE(ARRAY_AGG(DISTINCT pl.name), NULL) AS product_line_names
         FROM catalog.product_variants pv
         INNER JOIN catalog.products p ON p.id = pv.product_id
         LEFT JOIN catalog.product_line_products plp ON plp.product_id = p.id
         LEFT JOIN catalog.product_lines pl ON pl.id = plp.product_line_id
         ${whereSql}
         GROUP BY p.id, p.sku, p.name, p.category, p.is_active,
                  pv.id, pv.sku, pv.name, pv.is_active, pv.position
         ORDER BY p.name ASC, pv.position ASC, pv.name ASC`,
        params,
      );

      return result.rows.map(mapCatalogPreviewRow);
    } finally {
      client.release();
    }
  }
}

async function listRulesWithClient(
  client: PoolClient,
  input: ListDropshipCatalogExposureRulesInput,
): Promise<DropshipCatalogExposureRuleRecord[]> {
  const result = await client.query<CatalogRuleRow>(
    `SELECT id, revision_id, scope_type, action, product_line_id, product_id,
            product_variant_id, category, priority, is_active, starts_at, ends_at,
            notes, metadata, created_at, updated_at
     FROM dropship.dropship_catalog_rules
     WHERE ($1::boolean = true OR is_active = true)
     ORDER BY is_active DESC, priority DESC, id ASC`,
    [input.includeInactive],
  );
  return result.rows.map(mapCatalogRuleRow);
}

async function insertRule(
  client: PoolClient,
  revisionId: number,
  rule: NormalizedDropshipCatalogExposureRule,
  now: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_catalog_rules
      (revision_id, scope_type, action, product_line_id, product_id, product_variant_id,
       category, priority, is_active, starts_at, ends_at, notes, metadata, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, $10, $11, $12::jsonb, $13, $13)`,
    [
      revisionId,
      rule.scopeType,
      rule.action,
      rule.productLineId,
      rule.productId,
      rule.productVariantId,
      rule.category,
      rule.priority,
      rule.startsAt,
      rule.endsAt,
      rule.notes,
      JSON.stringify(rule.metadata),
      now,
    ],
  );
}

async function recordAuditEvent(
  client: PoolClient,
  input: {
    revisionId: number;
    actorType: "admin" | "system";
    actorId?: string;
    beforeRules: DropshipCatalogExposureRuleRecord[];
    afterRules: DropshipCatalogExposureRuleRecord[];
    now: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
      (entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
     VALUES ('dropship_catalog_ruleset', $1, 'catalog_rules_replaced', $2, $3, 'info', $4::jsonb, $5)`,
    [
      String(input.revisionId),
      input.actorType,
      input.actorId ?? null,
      JSON.stringify({
        beforeRules: input.beforeRules.map(serializeRuleForAudit),
        afterRules: input.afterRules.map(serializeRuleForAudit),
      }),
      input.now,
    ],
  );
}

function mapCatalogRuleRow(row: CatalogRuleRow): DropshipCatalogExposureRuleRecord {
  return {
    id: row.id,
    revisionId: row.revision_id,
    scopeType: row.scope_type as DropshipCatalogExposureRuleRecord["scopeType"],
    action: row.action as DropshipCatalogExposureRuleRecord["action"],
    productLineId: row.product_line_id,
    productId: row.product_id,
    productVariantId: row.product_variant_id,
    category: row.category,
    priority: row.priority,
    isActive: row.is_active,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    notes: row.notes,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCatalogPreviewRow(row: CatalogPreviewRow): DropshipCatalogPreviewCandidate {
  return {
    productId: row.product_id,
    productSku: row.product_sku,
    productName: row.product_name,
    productVariantId: row.product_variant_id,
    variantSku: row.variant_sku,
    variantName: row.variant_name,
    category: row.product_category,
    productLineIds: row.product_line_ids ?? [],
    productLineNames: row.product_line_names ?? [],
    productIsActive: row.product_is_active,
    variantIsActive: row.variant_is_active,
  };
}

function serializeRuleForAudit(rule: DropshipCatalogExposureRuleRecord): Record<string, unknown> {
  return {
    id: rule.id,
    revisionId: rule.revisionId,
    scopeType: rule.scopeType,
    action: rule.action,
    productLineId: rule.productLineId,
    productId: rule.productId,
    productVariantId: rule.productVariantId,
    category: rule.category,
    priority: rule.priority,
    startsAt: rule.startsAt?.toISOString() ?? null,
    endsAt: rule.endsAt?.toISOString() ?? null,
    notes: rule.notes,
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
