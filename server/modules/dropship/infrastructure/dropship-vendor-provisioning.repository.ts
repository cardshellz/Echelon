import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import type {
  DropshipActivateVendorRepositoryInput,
  DropshipCatalogSetupSummary,
  DropshipProvisionVendorRepositoryInput,
  DropshipProvisionVendorRepositoryResult,
  DropshipProvisionedVendorProfile,
  DropshipStoreConnectionSummary,
  DropshipVendorProvisioningRepository,
  DropshipWalletSetupSummary,
} from "../application/dropship-vendor-provisioning-service";
import { ensureDropshipWalletScaffoldingForVendor } from "./dropship-wallet.repository";
import { DropshipError } from "../domain/errors";

interface VendorProfileRow {
  id: number;
  member_id: string;
  current_subscription_id: string | null;
  current_plan_id: string | null;
  business_name: string | null;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  status: string;
  entitlement_status: string;
  entitlement_checked_at: Date | null;
  membership_grace_ends_at: Date | null;
  included_store_connections: number;
  created_at: Date;
  updated_at: Date;
}

interface StoreConnectionSummaryRow {
  active_count: string | number;
  connected_count: string | number;
  needs_attention_count: string | number;
  total_count: string | number;
}

interface CatalogSetupSummaryRow {
  admin_exposure_rule_count: string | number;
  vendor_selection_rule_count: string | number;
}

interface WalletSetupSummaryRow {
  available_balance_cents: string | number;
  pending_balance_cents: string | number;
  active_funding_method_count: string | number;
  auto_reload_enabled: boolean;
  auto_reload_funding_method_id: number | null;
  auto_reload_funding_method_active: boolean;
}

export class PgDropshipVendorProvisioningRepository implements DropshipVendorProvisioningRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async provisionVendor(
    input: DropshipProvisionVendorRepositoryInput,
  ): Promise<DropshipProvisionVendorRepositoryResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('dropship_vendor_profile'), hashtext($1))", [
        input.entitlement.memberId,
      ]);

      const existing = await findVendorByMemberIdWithClient(client, input.entitlement.memberId, true);
      const status = input.resolveStatus(existing?.status ?? null);
      if (!existing) {
        const vendor = await insertVendorProfile(client, input, status);
        await ensureDropshipWalletScaffoldingForVendor(client, {
          vendorId: vendor.vendorId,
          now: input.checkedAt,
        });
        await recordVendorProvisioningAuditEvent(client, {
          vendor,
          eventType: "vendor_profile_provisioned",
          changedFields: [
            "memberId",
            "currentSubscriptionId",
            "currentPlanId",
            "email",
            "status",
            "entitlementStatus",
          ],
          before: null,
          after: serializeVendorProfileForAudit(vendor),
          occurredAt: input.checkedAt,
        });
        await client.query("COMMIT");
        return {
          vendor,
          created: true,
          changedFields: [
            "memberId",
            "currentSubscriptionId",
            "currentPlanId",
            "email",
            "status",
            "entitlementStatus",
          ],
        };
      }

      const changedFields = changedVendorProfileFields(existing, input, status);
      const vendor = await updateVendorProfile(client, existing.vendorId, input, status);
      await ensureDropshipWalletScaffoldingForVendor(client, {
        vendorId: vendor.vendorId,
        now: input.checkedAt,
      });
      if (changedFields.length > 0) {
        await recordVendorProvisioningAuditEvent(client, {
          vendor,
          eventType: "vendor_profile_synced",
          changedFields,
          before: serializeVendorProfileForAudit(existing),
          after: serializeVendorProfileForAudit(vendor),
          occurredAt: input.checkedAt,
        });
      }

      await client.query("COMMIT");
      return {
        vendor,
        created: false,
        changedFields,
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async getStoreConnectionSummary(vendorId: number): Promise<DropshipStoreConnectionSummary> {
    const client = await this.dbPool.connect();
    try {
      const result = await client.query<StoreConnectionSummaryRow>(
        `SELECT
           COUNT(*) FILTER (
             WHERE status IN ('connected','needs_reauth','refresh_failed','grace_period','paused')
           ) AS active_count,
           COUNT(*) FILTER (WHERE status = 'connected') AS connected_count,
           COUNT(*) FILTER (
             WHERE status IN ('needs_reauth','refresh_failed','grace_period','paused')
           ) AS needs_attention_count,
           COUNT(*) AS total_count
         FROM dropship.dropship_store_connections
         WHERE vendor_id = $1`,
        [vendorId],
      );
      const row = result.rows[0];
      return {
        activeCount: Number(row?.active_count ?? 0),
        connectedCount: Number(row?.connected_count ?? 0),
        needsAttentionCount: Number(row?.needs_attention_count ?? 0),
        totalCount: Number(row?.total_count ?? 0),
      };
    } finally {
      client.release();
    }
  }

  async getCatalogSetupSummary(vendorId: number): Promise<DropshipCatalogSetupSummary> {
    const client = await this.dbPool.connect();
    try {
      const result = await client.query<CatalogSetupSummaryRow>(
        `SELECT
           (SELECT COUNT(*) FROM dropship.dropship_catalog_rules WHERE is_active = true) AS admin_exposure_rule_count,
           (
             SELECT COUNT(*)
             FROM dropship.dropship_vendor_selection_rules
             WHERE vendor_id = $1
               AND is_active = true
           ) AS vendor_selection_rule_count`,
        [vendorId],
      );
      const row = result.rows[0];
      return {
        adminExposureRuleCount: Number(row?.admin_exposure_rule_count ?? 0),
        vendorSelectionRuleCount: Number(row?.vendor_selection_rule_count ?? 0),
      };
    } finally {
      client.release();
    }
  }

  async getWalletSetupSummary(vendorId: number): Promise<DropshipWalletSetupSummary> {
    const client = await this.dbPool.connect();
    try {
      const result = await client.query<WalletSetupSummaryRow>(
        `SELECT
           COALESCE(wa.available_balance_cents, 0) AS available_balance_cents,
           COALESCE(wa.pending_balance_cents, 0) AS pending_balance_cents,
           COUNT(fm.id) FILTER (WHERE fm.status = 'active') AS active_funding_method_count,
           COALESCE(ar.enabled, false) AS auto_reload_enabled,
           ar.funding_method_id AS auto_reload_funding_method_id,
           COALESCE(ar_fm.status = 'active', false) AS auto_reload_funding_method_active
         FROM (SELECT $1::integer AS vendor_id) AS v
         LEFT JOIN dropship.dropship_wallet_accounts wa
           ON wa.vendor_id = v.vendor_id
         LEFT JOIN dropship.dropship_auto_reload_settings ar
           ON ar.vendor_id = v.vendor_id
         LEFT JOIN dropship.dropship_funding_methods fm
           ON fm.vendor_id = v.vendor_id
         LEFT JOIN dropship.dropship_funding_methods ar_fm
           ON ar_fm.id = ar.funding_method_id
          AND ar_fm.vendor_id = v.vendor_id
         GROUP BY wa.available_balance_cents, wa.pending_balance_cents, ar.enabled, ar.funding_method_id, ar_fm.status`,
        [vendorId],
      );
      const row = result.rows[0];
      return {
        availableBalanceCents: Number(row?.available_balance_cents ?? 0),
        pendingBalanceCents: Number(row?.pending_balance_cents ?? 0),
        activeFundingMethodCount: Number(row?.active_funding_method_count ?? 0),
        autoReloadEnabled: row?.auto_reload_enabled === true,
        autoReloadFundingMethodId: row?.auto_reload_funding_method_id ?? null,
        autoReloadFundingMethodActive: row?.auto_reload_funding_method_active === true,
      };
    } finally {
      client.release();
    }
  }

  async activateVendor(input: DropshipActivateVendorRepositoryInput): Promise<DropshipProvisionedVendorProfile> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const existing = await findVendorByIdWithClient(client, input.vendorId, true);
      if (!existing) {
        throw new DropshipError(
          "DROPSHIP_VENDOR_NOT_FOUND",
          "Dropship vendor was not found for onboarding activation.",
          { vendorId: input.vendorId },
        );
      }
      if (existing.status === "active") {
        await client.query("COMMIT");
        return existing;
      }
      if (existing.status !== "onboarding") {
        throw new DropshipError(
          "DROPSHIP_ONBOARDING_ACTIVATION_BLOCKED",
          "Dropship vendor status does not allow onboarding activation.",
          { vendorId: input.vendorId, status: existing.status },
        );
      }

      const result = await client.query<VendorProfileRow>(
        `UPDATE dropship.dropship_vendors
         SET status = 'active',
             updated_at = $2
         WHERE id = $1
           AND status = 'onboarding'
         RETURNING id, member_id, current_subscription_id, current_plan_id, business_name,
                   contact_name, email, phone, status, entitlement_status, entitlement_checked_at,
                   membership_grace_ends_at, included_store_connections, created_at, updated_at`,
        [input.vendorId, input.activatedAt],
      );
      const vendor = mapVendorProfileRow(result.rows[0]);
      if (!vendor) {
        throw new Error("Dropship vendor activation did not return a vendor row.");
      }
      await recordVendorProvisioningAuditEvent(client, {
        vendor,
        eventType: "vendor_onboarding_activated",
        changedFields: ["status"],
        before: serializeVendorProfileForAudit(existing),
        after: serializeVendorProfileForAudit(vendor),
        occurredAt: input.activatedAt,
      });
      await client.query("COMMIT");
      return vendor;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function findVendorByMemberIdWithClient(
  client: PoolClient,
  memberId: string,
  forUpdate: boolean,
): Promise<DropshipProvisionedVendorProfile | null> {
  const result = await client.query<VendorProfileRow>(
    `SELECT id, member_id, current_subscription_id, current_plan_id, business_name,
            contact_name, email, phone, status, entitlement_status, entitlement_checked_at,
            membership_grace_ends_at, included_store_connections, created_at, updated_at
     FROM dropship.dropship_vendors
     WHERE member_id::text = $1
     LIMIT 1
     ${forUpdate ? "FOR UPDATE" : ""}`,
    [memberId],
  );
  return mapVendorProfileRow(result.rows[0]);
}

async function findVendorByIdWithClient(
  client: PoolClient,
  vendorId: number,
  forUpdate: boolean,
): Promise<DropshipProvisionedVendorProfile | null> {
  const result = await client.query<VendorProfileRow>(
    `SELECT id, member_id, current_subscription_id, current_plan_id, business_name,
            contact_name, email, phone, status, entitlement_status, entitlement_checked_at,
            membership_grace_ends_at, included_store_connections, created_at, updated_at
     FROM dropship.dropship_vendors
     WHERE id = $1
     LIMIT 1
     ${forUpdate ? "FOR UPDATE" : ""}`,
    [vendorId],
  );
  return mapVendorProfileRow(result.rows[0]);
}

async function insertVendorProfile(
  client: PoolClient,
  input: DropshipProvisionVendorRepositoryInput,
  status: string,
): Promise<DropshipProvisionedVendorProfile> {
  const result = await client.query<VendorProfileRow>(
    `INSERT INTO dropship.dropship_vendors
      (member_id, current_subscription_id, current_plan_id, email, status,
       entitlement_status, entitlement_checked_at, membership_grace_ends_at,
       included_store_connections, metadata, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, 1, '{}'::jsonb, $7, $7)
     RETURNING id, member_id, current_subscription_id, current_plan_id, business_name,
               contact_name, email, phone, status, entitlement_status, entitlement_checked_at,
               membership_grace_ends_at, included_store_connections, created_at, updated_at`,
    [
      input.entitlement.memberId,
      input.entitlement.subscriptionId,
      input.entitlement.planId,
      input.entitlement.cardShellzEmail,
      status,
      input.entitlement.status,
      input.checkedAt,
    ],
  );
  const vendor = mapVendorProfileRow(result.rows[0]);
  if (!vendor) {
    throw new Error("Dropship vendor provisioning insert did not return a vendor row.");
  }
  return vendor;
}

async function updateVendorProfile(
  client: PoolClient,
  vendorId: number,
  input: DropshipProvisionVendorRepositoryInput,
  status: string,
): Promise<DropshipProvisionedVendorProfile> {
  const result = await client.query<VendorProfileRow>(
    `UPDATE dropship.dropship_vendors
     SET current_subscription_id = $2,
         current_plan_id = $3,
         email = $4,
         status = $5,
         entitlement_status = $6,
         entitlement_checked_at = $7,
         membership_grace_ends_at = NULL,
         updated_at = $7
     WHERE id = $1
     RETURNING id, member_id, current_subscription_id, current_plan_id, business_name,
               contact_name, email, phone, status, entitlement_status, entitlement_checked_at,
               membership_grace_ends_at, included_store_connections, created_at, updated_at`,
    [
      vendorId,
      input.entitlement.subscriptionId,
      input.entitlement.planId,
      input.entitlement.cardShellzEmail,
      status,
      input.entitlement.status,
      input.checkedAt,
    ],
  );
  const vendor = mapVendorProfileRow(result.rows[0]);
  if (!vendor) {
    throw new Error("Dropship vendor provisioning update did not return a vendor row.");
  }
  return vendor;
}

function changedVendorProfileFields(
  existing: DropshipProvisionedVendorProfile,
  input: DropshipProvisionVendorRepositoryInput,
  status: string,
): string[] {
  const comparisons: Array<[string, unknown, unknown]> = [
    ["currentSubscriptionId", existing.currentSubscriptionId, input.entitlement.subscriptionId],
    ["currentPlanId", existing.currentPlanId, input.entitlement.planId],
    ["email", existing.email, input.entitlement.cardShellzEmail],
    ["status", existing.status, status],
    ["entitlementStatus", existing.entitlementStatus, input.entitlement.status],
  ];

  return comparisons
    .filter(([, before, after]) => normalizeNullableValue(before) !== normalizeNullableValue(after))
    .map(([field]) => field);
}

async function recordVendorProvisioningAuditEvent(
  client: PoolClient,
  input: {
    vendor: DropshipProvisionedVendorProfile;
    eventType: "vendor_profile_provisioned" | "vendor_profile_synced" | "vendor_onboarding_activated";
    changedFields: string[];
    before: Record<string, unknown> | null;
    after: Record<string, unknown>;
    occurredAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
      (vendor_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, 'dropship_vendor', $2, $3, 'system', NULL, 'info', $4::jsonb, $5)`,
    [
      input.vendor.vendorId,
      String(input.vendor.vendorId),
      input.eventType,
      JSON.stringify({
        changedFields: input.changedFields,
        before: input.before,
        after: input.after,
      }),
      input.occurredAt,
    ],
  );
}

function mapVendorProfileRow(row: VendorProfileRow | undefined): DropshipProvisionedVendorProfile | null {
  if (!row) {
    return null;
  }

  return {
    vendorId: row.id,
    memberId: row.member_id,
    currentSubscriptionId: row.current_subscription_id,
    currentPlanId: row.current_plan_id,
    businessName: row.business_name,
    contactName: row.contact_name,
    email: row.email,
    phone: row.phone,
    status: row.status,
    entitlementStatus: row.entitlement_status,
    entitlementCheckedAt: row.entitlement_checked_at,
    membershipGraceEndsAt: row.membership_grace_ends_at,
    includedStoreConnections: row.included_store_connections,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeVendorProfileForAudit(
  vendor: DropshipProvisionedVendorProfile,
): Record<string, unknown> {
  return {
    vendorId: vendor.vendorId,
    memberId: vendor.memberId,
    currentSubscriptionId: vendor.currentSubscriptionId,
    currentPlanId: vendor.currentPlanId,
    email: vendor.email,
    status: vendor.status,
    entitlementStatus: vendor.entitlementStatus,
    includedStoreConnections: vendor.includedStoreConnections,
  };
}

function normalizeNullableValue(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original failure.
  }
}
