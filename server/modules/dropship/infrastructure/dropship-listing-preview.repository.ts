import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { DropshipError } from "../domain/errors";
import type {
  CreateDropshipListingPushJobRepositoryInput,
  CreateDropshipListingPushJobRepositoryResult,
  DropshipExistingVendorListing,
  DropshipListingCatalogCandidate,
  DropshipListingPackageReadiness,
  DropshipListingPreviewRepository,
  DropshipListingStoreContext,
  DropshipListingPushJobItemRecord,
  DropshipListingPushJobRecord,
  DropshipPricingPolicyRecord,
} from "../application/dropship-listing-preview-service";
import type { DropshipStoreListingConfig } from "../application/dropship-marketplace-listing-provider";
import type { DropshipCatalogExposureRule } from "../domain/catalog-exposure";
import type { DropshipVendorSelectionRule, DropshipVendorVariantOverride } from "../domain/vendor-selection";

interface StoreContextRow {
  vendor_id: number;
  vendor_status: DropshipListingStoreContext["vendorStatus"];
  entitlement_status: string;
  store_connection_id: number;
  store_status: DropshipListingStoreContext["storeStatus"];
  setup_status: string;
  platform: DropshipListingStoreContext["platform"];
}

interface StoreListingConfigRow {
  id: number;
  store_connection_id: number;
  platform: DropshipStoreListingConfig["platform"];
  listing_mode: DropshipStoreListingConfig["listingMode"];
  inventory_mode: DropshipStoreListingConfig["inventoryMode"];
  price_mode: DropshipStoreListingConfig["priceMode"];
  marketplace_config: Record<string, unknown> | null;
  required_config_keys: unknown;
  required_product_fields: unknown;
  is_active: boolean;
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
  scope_type: string;
  action: string;
  product_line_id: number | null;
  product_id: number | null;
  product_variant_id: number | null;
  category: string | null;
  auto_connect_new_skus: boolean;
  auto_list_new_skus: boolean;
  is_active: boolean;
}

interface CandidateRow {
  product_id: number;
  product_variant_id: number;
  product_line_ids: number[] | null;
  product_sku: string | null;
  variant_sku: string | null;
  product_name: string;
  variant_name: string;
  title: string | null;
  description: string | null;
  category: string | null;
  brand: string | null;
  gtin: string | null;
  mpn: string | null;
  condition: string | null;
  item_specifics: Record<string, unknown> | null;
  product_is_active: boolean;
  variant_is_active: boolean;
  units_per_variant: number;
  default_retail_price_cents: string | number | null;
}

interface OverrideRow {
  product_variant_id: number;
  enabled_override: boolean | null;
  marketplace_quantity_cap: number | null;
}

interface ExistingListingRow {
  id: number;
  product_variant_id: number;
  status: string;
  vendor_retail_price_cents: string | number | null;
  quantity_cap: number | null;
  external_listing_id: string | null;
}

interface PricingPolicyRow {
  id: number;
  scope_type: DropshipPricingPolicyRecord["scopeType"];
  product_line_id: number | null;
  product_id: number | null;
  product_variant_id: number | null;
  category: string | null;
  mode: DropshipPricingPolicyRecord["mode"];
  floor_price_cents: string | number | null;
  ceiling_price_cents: string | number | null;
}

interface PackageReadinessRow {
  product_variant_id: number;
}

interface CountRow {
  count: string | number;
}

interface JobRow {
  id: number;
  vendor_id: number;
  store_connection_id: number;
  status: string;
  idempotency_key: string | null;
  request_hash: string | null;
  created_at: Date;
  updated_at: Date;
}

interface JobItemRow {
  id: number;
  job_id: number;
  listing_id: number | null;
  product_variant_id: number;
  status: string;
  preview_hash: string | null;
  error_code: string | null;
  error_message: string | null;
}

export class PgDropshipListingPreviewRepository implements DropshipListingPreviewRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async loadStoreContext(input: {
    vendorId: number;
    storeConnectionId: number;
  }): Promise<DropshipListingStoreContext | null> {
    const client = await this.dbPool.connect();
    try {
      const result = await client.query<StoreContextRow>(
        `SELECT
           v.id AS vendor_id,
           v.status AS vendor_status,
           v.entitlement_status,
           sc.id AS store_connection_id,
           sc.status AS store_status,
           sc.setup_status,
           sc.platform
         FROM dropship.dropship_vendors v
         INNER JOIN dropship.dropship_store_connections sc ON sc.vendor_id = v.id
         WHERE v.id = $1
           AND sc.id = $2
         LIMIT 1`,
        [input.vendorId, input.storeConnectionId],
      );
      const row = result.rows[0];
      return row ? {
        vendorId: row.vendor_id,
        vendorStatus: row.vendor_status,
        entitlementStatus: row.entitlement_status,
        storeConnectionId: row.store_connection_id,
        storeStatus: row.store_status,
        setupStatus: row.setup_status,
        platform: row.platform,
      } : null;
    } finally {
      client.release();
    }
  }

  async getStoreListingConfig(storeConnectionId: number): Promise<DropshipStoreListingConfig | null> {
    const client = await this.dbPool.connect();
    try {
      const result = await client.query<StoreListingConfigRow>(
        `SELECT id, store_connection_id, platform, listing_mode, inventory_mode, price_mode,
                marketplace_config, required_config_keys, required_product_fields, is_active
         FROM dropship.dropship_store_listing_configs
         WHERE store_connection_id = $1
         LIMIT 1`,
        [storeConnectionId],
      );
      const row = result.rows[0];
      return row ? mapStoreListingConfigRow(row) : null;
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
      return result.rows.map(mapCatalogRuleRow);
    } finally {
      client.release();
    }
  }

  async listSelectionRules(vendorId: number): Promise<DropshipVendorSelectionRule[]> {
    const client = await this.dbPool.connect();
    try {
      const result = await client.query<SelectionRuleRow>(
        `SELECT id, scope_type, action, product_line_id, product_id,
                product_variant_id, category, auto_connect_new_skus,
                auto_list_new_skus, is_active
         FROM dropship.dropship_vendor_selection_rules
         WHERE vendor_id = $1 AND is_active = true
         ORDER BY priority DESC, id ASC`,
        [vendorId],
      );
      return result.rows.map(mapSelectionRuleRow);
    } finally {
      client.release();
    }
  }

  async listCatalogCandidates(productVariantIds: readonly number[]): Promise<DropshipListingCatalogCandidate[]> {
    if (productVariantIds.length === 0) return [];
    const client = await this.dbPool.connect();
    try {
      const result = await client.query<CandidateRow>(
        `SELECT
           p.id AS product_id,
           pv.id AS product_variant_id,
           ARRAY_REMOVE(ARRAY_AGG(DISTINCT plp.product_line_id), NULL) AS product_line_ids,
           p.sku AS product_sku,
           pv.sku AS variant_sku,
           p.name AS product_name,
           pv.name AS variant_name,
           COALESCE(p.title, p.name) AS title,
           p.description,
           p.category,
           p.brand,
           pv.gtin,
           pv.mpn,
           p.condition AS condition,
           p.item_specifics,
           p.is_active AS product_is_active,
           pv.is_active AS variant_is_active,
           pv.units_per_variant,
           pv.price_cents AS default_retail_price_cents
         FROM catalog.product_variants pv
         INNER JOIN catalog.products p ON p.id = pv.product_id
         LEFT JOIN catalog.product_line_products plp ON plp.product_id = p.id
         WHERE pv.id = ANY($1::int[])
         GROUP BY p.id, pv.id`,
        [productVariantIds],
      );
      return result.rows.map(mapCandidateRow);
    } finally {
      client.release();
    }
  }

  async listVariantOverrides(input: {
    vendorId: number;
    productVariantIds: readonly number[];
  }): Promise<DropshipVendorVariantOverride[]> {
    if (input.productVariantIds.length === 0) return [];
    const client = await this.dbPool.connect();
    try {
      const result = await client.query<OverrideRow>(
        `SELECT product_variant_id, enabled_override, marketplace_quantity_cap
         FROM dropship.dropship_vendor_variant_overrides
         WHERE vendor_id = $1
           AND product_variant_id = ANY($2::int[])`,
        [input.vendorId, input.productVariantIds],
      );
      return result.rows.map((row) => ({
        productVariantId: row.product_variant_id,
        enabledOverride: row.enabled_override,
        marketplaceQuantityCap: row.marketplace_quantity_cap,
      }));
    } finally {
      client.release();
    }
  }

  async listExistingListings(input: {
    storeConnectionId: number;
    productVariantIds: readonly number[];
  }): Promise<DropshipExistingVendorListing[]> {
    if (input.productVariantIds.length === 0) return [];
    const client = await this.dbPool.connect();
    try {
      const result = await client.query<ExistingListingRow>(
        `SELECT id, product_variant_id, status, vendor_retail_price_cents,
                quantity_cap, external_listing_id
         FROM dropship.dropship_vendor_listings
         WHERE store_connection_id = $1
           AND product_variant_id = ANY($2::int[])`,
        [input.storeConnectionId, input.productVariantIds],
      );
      return result.rows.map(mapExistingListingRow);
    } finally {
      client.release();
    }
  }

  async listPricingPolicies(): Promise<DropshipPricingPolicyRecord[]> {
    const client = await this.dbPool.connect();
    try {
      const result = await client.query<PricingPolicyRow>(
        `SELECT id, scope_type, product_line_id, product_id, product_variant_id,
                category, mode, floor_price_cents, ceiling_price_cents
         FROM dropship.dropship_pricing_policies
         WHERE is_active = true
         ORDER BY id ASC`,
      );
      return result.rows.map(mapPricingPolicyRow);
    } finally {
      client.release();
    }
  }

  async getPackageReadiness(productVariantIds: readonly number[]): Promise<Map<number, DropshipListingPackageReadiness>> {
    const readiness = new Map<number, DropshipListingPackageReadiness>();
    productVariantIds.forEach((productVariantId) => readiness.set(productVariantId, {
      hasPackageProfile: false,
      hasActiveBox: false,
      hasActiveRateTable: false,
    }));
    if (productVariantIds.length === 0) return readiness;

    const client = await this.dbPool.connect();
    try {
      const profileResult = await client.query<PackageReadinessRow>(
        `SELECT product_variant_id
         FROM dropship.dropship_package_profiles
         WHERE product_variant_id = ANY($1::int[])
           AND is_active = true`,
        [productVariantIds],
      );
      const boxResult = await client.query<CountRow>(
        `SELECT COUNT(*) AS count
         FROM dropship.dropship_box_catalog
         WHERE is_active = true`,
      );
      const rateResult = await client.query<CountRow>(
        `SELECT COUNT(*) AS count
         FROM dropship.dropship_rate_tables
         WHERE status = 'active'
           AND effective_from <= now()
           AND (effective_to IS NULL OR effective_to > now())`,
      );
      const hasActiveBox = Number(boxResult.rows[0]?.count ?? 0) > 0;
      const hasActiveRateTable = Number(rateResult.rows[0]?.count ?? 0) > 0;
      const profileVariantIds = new Set(profileResult.rows.map((row) => row.product_variant_id));
      productVariantIds.forEach((productVariantId) => readiness.set(productVariantId, {
        hasPackageProfile: profileVariantIds.has(productVariantId),
        hasActiveBox,
        hasActiveRateTable,
      }));
      return readiness;
    } finally {
      client.release();
    }
  }

  async createListingPushJob(
    input: CreateDropshipListingPushJobRepositoryInput,
  ): Promise<CreateDropshipListingPushJobRepositoryResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('dropship_listing_push_job'), $1::integer)", [
        input.storeConnectionId,
      ]);

      const existingJob = await findJobByIdempotencyKeyForUpdate(client, {
        vendorId: input.vendorId,
        idempotencyKey: input.idempotencyKey,
      });
      if (existingJob) {
        if (existingJob.request_hash !== input.requestHash) {
          throw new DropshipError(
            "DROPSHIP_IDEMPOTENCY_CONFLICT",
            "Dropship listing push job idempotency key was reused with a different request.",
            { vendorId: input.vendorId, storeConnectionId: input.storeConnectionId },
          );
        }
        const items = await listJobItemsWithClient(client, existingJob.id);
        await client.query("COMMIT");
        return {
          job: mapJobRow(existingJob),
          items,
          idempotentReplay: true,
        };
      }

      const queuedItemCount = input.preview.rows.filter((row) => row.previewStatus !== "blocked").length;
      const jobStatus = queuedItemCount > 0 ? "queued" : "failed";
      const jobResult = await client.query<JobRow>(
        `INSERT INTO dropship.dropship_listing_push_jobs
          (vendor_id, store_connection_id, job_type, status, requested_scope,
           requested_by, idempotency_key, request_hash, error_message, created_at, updated_at)
         VALUES ($1, $2, 'push', $3, $4::jsonb, $5, $6, $7, $8, $9, $9)
         RETURNING id, vendor_id, store_connection_id, status, idempotency_key,
                   request_hash, created_at, updated_at`,
        [
          input.vendorId,
          input.storeConnectionId,
          jobStatus,
          JSON.stringify({
            productVariantIds: input.productVariantIds,
            previewSummary: input.preview.summary,
          }),
          input.requestedBy.actorId ?? input.requestedBy.actorType,
          input.idempotencyKey,
          input.requestHash,
          queuedItemCount > 0 ? null : "No listing items were ready to push.",
          input.now,
        ],
      );
      const job = requiredRow(jobResult.rows[0], "Dropship listing push job insert did not return a row.");

      for (const row of input.preview.rows) {
        const listingId = await upsertVendorListingForPreview(client, input, row);
        await insertJobItemForPreview(client, {
          jobId: job.id,
          listingId,
          idempotencyKey: `${input.idempotencyKey}:${row.productVariantId}`,
          row,
          now: input.now,
        });
      }

      await recordListingJobAuditEvent(client, input, job.id);
      const items = await listJobItemsWithClient(client, job.id);
      await client.query("COMMIT");
      return {
        job: mapJobRow(job),
        items,
        idempotentReplay: false,
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function findJobByIdempotencyKeyForUpdate(
  client: PoolClient,
  input: {
    vendorId: number;
    idempotencyKey: string;
  },
): Promise<JobRow | null> {
  const result = await client.query<JobRow>(
    `SELECT id, vendor_id, store_connection_id, status, idempotency_key,
            request_hash, created_at, updated_at
     FROM dropship.dropship_listing_push_jobs
     WHERE vendor_id = $1
       AND idempotency_key = $2
     FOR UPDATE`,
    [input.vendorId, input.idempotencyKey],
  );
  return result.rows[0] ?? null;
}

async function upsertVendorListingForPreview(
  client: PoolClient,
  input: CreateDropshipListingPushJobRepositoryInput,
  row: CreateDropshipListingPushJobRepositoryInput["preview"]["rows"][number],
): Promise<number | null> {
  if (row.productId <= 0) {
    return null;
  }
  const status = row.previewStatus === "blocked" ? "blocked" : "queued";
  const result = await client.query<{ id: number }>(
    `INSERT INTO dropship.dropship_vendor_listings
      (vendor_id, store_connection_id, product_variant_id, platform, status,
       vendor_retail_price_cents, pushed_quantity, quantity_cap, last_preview_hash,
       metadata, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, $9::jsonb, $10, $10)
     ON CONFLICT (store_connection_id, product_variant_id)
     DO UPDATE SET
       status = EXCLUDED.status,
       vendor_retail_price_cents = EXCLUDED.vendor_retail_price_cents,
       quantity_cap = EXCLUDED.quantity_cap,
       last_preview_hash = EXCLUDED.last_preview_hash,
       metadata = EXCLUDED.metadata,
       updated_at = EXCLUDED.updated_at
     RETURNING id`,
    [
      input.vendorId,
      input.storeConnectionId,
      row.productVariantId,
      input.platform,
      status,
      row.priceCents,
      row.marketplaceQuantity,
      row.previewHash,
      JSON.stringify({
        lastPreviewStatus: row.previewStatus,
        blockers: row.blockers,
        warnings: row.warnings,
        listingMode: row.listingMode,
      }),
      input.now,
    ],
  );
  return result.rows[0]?.id ?? null;
}

async function insertJobItemForPreview(
  client: PoolClient,
  input: {
    jobId: number;
    listingId: number | null;
    idempotencyKey: string;
    row: CreateDropshipListingPushJobRepositoryInput["preview"]["rows"][number];
    now: Date;
  },
): Promise<void> {
  const status = input.row.previewStatus === "blocked" ? "blocked" : "queued";
  await client.query(
    `INSERT INTO dropship.dropship_listing_push_job_items
      (job_id, listing_id, product_variant_id, action, status, preview_hash,
       error_code, error_message, result, idempotency_key, created_at, updated_at)
     VALUES ($1, $2, $3, 'push', $4, $5, $6, $7, $8::jsonb, $9, $10, $10)`,
    [
      input.jobId,
      input.listingId,
      input.row.productVariantId,
      status,
      input.row.previewHash,
      input.row.previewStatus === "blocked" ? "DROPSHIP_LISTING_PREVIEW_BLOCKED" : null,
      input.row.previewStatus === "blocked" ? input.row.blockers.join(", ") : null,
      JSON.stringify({
        previewStatus: input.row.previewStatus,
        blockers: input.row.blockers,
        warnings: input.row.warnings,
        listingIntent: input.row.listingIntent,
      }),
      input.idempotencyKey,
      input.now,
    ],
  );
}

async function listJobItemsWithClient(
  client: PoolClient,
  jobId: number,
): Promise<DropshipListingPushJobItemRecord[]> {
  const result = await client.query<JobItemRow>(
    `SELECT id, job_id, listing_id, product_variant_id, status, preview_hash,
            error_code, error_message
     FROM dropship.dropship_listing_push_job_items
     WHERE job_id = $1
     ORDER BY id ASC`,
    [jobId],
  );
  return result.rows.map(mapJobItemRow);
}

async function recordListingJobAuditEvent(
  client: PoolClient,
  input: CreateDropshipListingPushJobRepositoryInput,
  jobId: number,
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
      (vendor_id, store_connection_id, entity_type, entity_id, event_type,
       actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, $2, 'dropship_listing_push_job', $3, 'listing_push_job_created',
             $4, $5, 'info', $6::jsonb, $7)`,
    [
      input.vendorId,
      input.storeConnectionId,
      String(jobId),
      input.requestedBy.actorType,
      input.requestedBy.actorId ?? null,
      JSON.stringify({
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        previewSummary: input.preview.summary,
      }),
      input.now,
    ],
  );
}

function mapStoreListingConfigRow(row: StoreListingConfigRow): DropshipStoreListingConfig {
  return {
    id: row.id,
    storeConnectionId: row.store_connection_id,
    platform: row.platform,
    listingMode: row.listing_mode,
    inventoryMode: row.inventory_mode,
    priceMode: row.price_mode,
    marketplaceConfig: row.marketplace_config ?? {},
    requiredConfigKeys: stringArrayFromJson(row.required_config_keys),
    requiredProductFields: stringArrayFromJson(row.required_product_fields),
    isActive: row.is_active,
  };
}

function mapCatalogRuleRow(row: CatalogRuleRow): DropshipCatalogExposureRule {
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

function mapSelectionRuleRow(row: SelectionRuleRow): DropshipVendorSelectionRule {
  return {
    id: row.id,
    scopeType: row.scope_type as DropshipVendorSelectionRule["scopeType"],
    action: row.action as DropshipVendorSelectionRule["action"],
    productLineId: row.product_line_id,
    productId: row.product_id,
    productVariantId: row.product_variant_id,
    category: row.category,
    autoConnectNewSkus: row.auto_connect_new_skus,
    autoListNewSkus: row.auto_list_new_skus,
    isActive: row.is_active,
  };
}

function mapCandidateRow(row: CandidateRow): DropshipListingCatalogCandidate {
  return {
    productId: row.product_id,
    productVariantId: row.product_variant_id,
    productLineIds: row.product_line_ids ?? [],
    category: row.category,
    productIsActive: row.product_is_active,
    variantIsActive: row.variant_is_active,
    unitsPerVariant: Math.max(1, row.units_per_variant),
    defaultRetailPriceCents: row.default_retail_price_cents === null ? null : Number(row.default_retail_price_cents),
    sku: row.variant_sku ?? row.product_sku,
    productName: row.product_name,
    variantName: row.variant_name,
    title: row.title,
    description: row.description,
    brand: row.brand,
    gtin: row.gtin,
    mpn: row.mpn,
    condition: row.condition,
    itemSpecifics: row.item_specifics,
  };
}

function mapExistingListingRow(row: ExistingListingRow): DropshipExistingVendorListing {
  return {
    listingId: row.id,
    productVariantId: row.product_variant_id,
    status: row.status,
    vendorRetailPriceCents: row.vendor_retail_price_cents === null ? null : Number(row.vendor_retail_price_cents),
    quantityCap: row.quantity_cap,
    externalListingId: row.external_listing_id,
  };
}

function mapPricingPolicyRow(row: PricingPolicyRow): DropshipPricingPolicyRecord {
  return {
    id: row.id,
    scopeType: row.scope_type,
    productLineId: row.product_line_id,
    productId: row.product_id,
    productVariantId: row.product_variant_id,
    category: row.category,
    mode: row.mode,
    floorPriceCents: row.floor_price_cents === null ? null : Number(row.floor_price_cents),
    ceilingPriceCents: row.ceiling_price_cents === null ? null : Number(row.ceiling_price_cents),
  };
}

function mapJobRow(row: JobRow): DropshipListingPushJobRecord {
  return {
    jobId: row.id,
    vendorId: row.vendor_id,
    storeConnectionId: row.store_connection_id,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapJobItemRow(row: JobItemRow): DropshipListingPushJobItemRecord {
  return {
    itemId: row.id,
    jobId: row.job_id,
    listingId: row.listing_id,
    productVariantId: row.product_variant_id,
    status: row.status,
    previewHash: row.preview_hash,
    errorCode: row.error_code,
    errorMessage: row.error_message,
  };
}

function stringArrayFromJson(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function requiredRow<T>(row: T | undefined, message: string): T {
  if (!row) {
    throw new Error(message);
  }
  return row;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve original error.
  }
}
