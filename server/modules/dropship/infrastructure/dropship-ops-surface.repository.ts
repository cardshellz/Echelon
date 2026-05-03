import type { Pool } from "pg";
import { pool as defaultPool } from "../../../db";
import {
  buildDropshipSettingsSections,
  type DropshipAdminOpsOverview,
  type DropshipAuditEventRecord,
  type DropshipAuditEventSearchResult,
  type DropshipOpsCount,
  type DropshipOpsRiskBucket,
  type DropshipOpsSurfaceRepository,
  type DropshipVendorSettingsOverview,
  type GetDropshipAdminOpsOverviewInput,
  type SearchDropshipAuditEventsInput,
} from "../application/dropship-ops-surface-service";
import { DropshipError } from "../domain/errors";

interface VendorSettingsRow {
  id: number;
  member_id: string;
  business_name: string | null;
  email: string | null;
  status: string;
  entitlement_status: string;
  included_store_connections: number;
  available_balance_cents: string | number | null;
  pending_balance_cents: string | number | null;
  auto_reload_enabled: boolean | null;
  funding_method_count: string | number;
  notification_preference_count: string | number;
}

interface StoreConnectionRow {
  id: number;
  platform: string;
  status: string;
  setup_status: string;
  external_display_name: string | null;
  shop_domain: string | null;
  updated_at: Date;
}

interface CountRow {
  key: string;
  count: string | number;
}

interface AuditEventRow {
  id: number;
  vendor_id: number | null;
  vendor_business_name: string | null;
  vendor_email: string | null;
  store_connection_id: number | null;
  store_platform: string | null;
  store_display_name: string | null;
  entity_type: string;
  entity_id: string | null;
  event_type: string;
  actor_type: string;
  actor_id: string | null;
  severity: "info" | "warning" | "error";
  payload: Record<string, unknown> | null;
  created_at: Date;
  total_count?: string | number;
}

export class PgDropshipOpsSurfaceRepository implements DropshipOpsSurfaceRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async getVendorSettingsOverview(
    vendorId: number,
    generatedAt: Date,
  ): Promise<DropshipVendorSettingsOverview> {
    const [vendorResult, storeResult] = await Promise.all([
      this.dbPool.query<VendorSettingsRow>(
        `SELECT v.id, v.member_id, v.business_name, v.email, v.status,
                v.entitlement_status, v.included_store_connections,
                wa.available_balance_cents, wa.pending_balance_cents,
                ars.enabled AS auto_reload_enabled,
                COALESCE(fm.funding_method_count, 0) AS funding_method_count,
                COALESCE(np.notification_preference_count, 0) AS notification_preference_count
         FROM dropship.dropship_vendors v
         LEFT JOIN dropship.dropship_wallet_accounts wa ON wa.vendor_id = v.id
         LEFT JOIN dropship.dropship_auto_reload_settings ars ON ars.vendor_id = v.id
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS funding_method_count
           FROM dropship.dropship_funding_methods
           WHERE vendor_id = v.id
             AND status = 'active'
         ) fm ON true
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS notification_preference_count
           FROM dropship.dropship_notification_preferences
           WHERE vendor_id = v.id
         ) np ON true
         WHERE v.id = $1
         LIMIT 1`,
        [vendorId],
      ),
      this.dbPool.query<StoreConnectionRow>(
        `SELECT id, platform, status, setup_status, external_display_name,
                shop_domain, updated_at
         FROM dropship.dropship_store_connections
         WHERE vendor_id = $1
         ORDER BY updated_at DESC, id DESC`,
        [vendorId],
      ),
    ]);

    const vendor = vendorResult.rows[0];
    if (!vendor) {
      throw new DropshipError("DROPSHIP_VENDOR_NOT_FOUND", "Dropship vendor was not found.", { vendorId });
    }

    const storeConnections = storeResult.rows.map((row) => ({
      storeConnectionId: row.id,
      platform: row.platform,
      status: row.status,
      setupStatus: row.setup_status,
      externalDisplayName: row.external_display_name,
      shopDomain: row.shop_domain,
      updatedAt: row.updated_at,
    }));
    const wallet = {
      availableBalanceCents: toNumber(vendor.available_balance_cents ?? 0),
      pendingBalanceCents: toNumber(vendor.pending_balance_cents ?? 0),
      autoReloadEnabled: vendor.auto_reload_enabled === true,
      fundingMethodCount: toNumber(vendor.funding_method_count),
    };
    const account = {
      hasContactEmail: Boolean(vendor.email?.trim()),
      hasBusinessName: Boolean(vendor.business_name?.trim()),
    };
    const notificationPreferenceCount = toNumber(vendor.notification_preference_count);

    return {
      vendor: {
        vendorId: vendor.id,
        memberId: vendor.member_id,
        businessName: vendor.business_name,
        email: vendor.email,
        status: vendor.status,
        entitlementStatus: vendor.entitlement_status,
        includedStoreConnections: vendor.included_store_connections,
      },
      account,
      storeConnections,
      wallet,
      notificationPreferences: {
        configuredCount: notificationPreferenceCount,
      },
      sections: buildDropshipSettingsSections({
        vendorStatus: vendor.status,
        entitlementStatus: vendor.entitlement_status,
        storeConnections,
        wallet,
        notificationPreferenceCount,
        hasContactEmail: account.hasContactEmail,
      }),
      generatedAt,
    };
  }

  async getAdminOpsOverview(
    input: GetDropshipAdminOpsOverviewInput & { generatedAt: Date },
  ): Promise<DropshipAdminOpsOverview> {
    const [
      vendorStatusCounts,
      storeConnectionStatusCounts,
      orderIntakeStatusCounts,
      listingPushJobStatusCounts,
      trackingPushStatusCounts,
      rmaStatusCounts,
      notificationStatusCounts,
      recentAuditEvents,
    ] = await Promise.all([
      this.countByStatus("dropship.dropship_vendors", "status", input, { hasVendorId: true, hasStoreConnectionId: false }),
      this.countByStatus("dropship.dropship_store_connections", "status", input, { hasVendorId: true, hasStoreConnectionId: true }),
      this.countByStatus("dropship.dropship_order_intake", "status", input, { hasVendorId: true, hasStoreConnectionId: true }),
      this.countByStatus("dropship.dropship_listing_push_jobs", "status", input, { hasVendorId: true, hasStoreConnectionId: false }),
      this.countByStatus("dropship.dropship_marketplace_tracking_pushes", "status", input, { hasVendorId: true, hasStoreConnectionId: true }),
      this.countByStatus("dropship.dropship_rmas", "status", input, { hasVendorId: true, hasStoreConnectionId: true }),
      this.countByStatus("dropship.dropship_notification_events", "status", input, { hasVendorId: true, hasStoreConnectionId: false }),
      this.searchAuditEvents({
        vendorId: input.vendorId,
        storeConnectionId: input.storeConnectionId,
        page: 1,
        limit: 10,
      }),
    ]);

    return {
      generatedAt: input.generatedAt,
      riskBuckets: buildRiskBuckets({
        storeConnectionStatusCounts,
        orderIntakeStatusCounts,
        listingPushJobStatusCounts,
        trackingPushStatusCounts,
        rmaStatusCounts,
        notificationStatusCounts,
      }),
      vendorStatusCounts,
      storeConnectionStatusCounts,
      orderIntakeStatusCounts,
      listingPushJobStatusCounts,
      trackingPushStatusCounts,
      rmaStatusCounts,
      notificationStatusCounts,
      recentAuditEvents: recentAuditEvents.items,
    };
  }

  async searchAuditEvents(input: SearchDropshipAuditEventsInput): Promise<DropshipAuditEventSearchResult> {
    const filters = buildAuditFilters(input);
    const offset = (input.page - 1) * input.limit;
    const result = await this.dbPool.query<AuditEventRow>(
      `SELECT ae.id, ae.vendor_id, v.business_name AS vendor_business_name,
              v.email AS vendor_email, ae.store_connection_id,
              sc.platform AS store_platform, sc.external_display_name AS store_display_name,
              ae.entity_type, ae.entity_id, ae.event_type, ae.actor_type, ae.actor_id,
              ae.severity, ae.payload, ae.created_at,
              COUNT(*) OVER() AS total_count
       FROM dropship.dropship_audit_events ae
       LEFT JOIN dropship.dropship_vendors v ON v.id = ae.vendor_id
       LEFT JOIN dropship.dropship_store_connections sc ON sc.id = ae.store_connection_id
       ${filters.whereSql}
       ORDER BY ae.created_at DESC, ae.id DESC
       LIMIT $${filters.params.length + 1} OFFSET $${filters.params.length + 2}`,
      [...filters.params, input.limit, offset],
    );

    return {
      items: result.rows.map(mapAuditEventRow),
      total: toNumber(result.rows[0]?.total_count ?? 0),
      page: input.page,
      limit: input.limit,
    };
  }

  private async countByStatus(
    tableName: string,
    statusColumn: string,
    input: { vendorId?: number; storeConnectionId?: number },
    options: { hasVendorId: boolean; hasStoreConnectionId: boolean },
  ): Promise<DropshipOpsCount[]> {
    const filters = buildScopeFilters(input, options);
    const result = await this.dbPool.query<CountRow>(
      `SELECT ${statusColumn} AS key, COUNT(*) AS count
       FROM ${tableName}
       ${filters.whereSql}
       GROUP BY ${statusColumn}
       ORDER BY ${statusColumn} ASC`,
      filters.params,
    );
    return result.rows.map(mapCountRow);
  }
}

function buildRiskBuckets(input: {
  storeConnectionStatusCounts: DropshipOpsCount[];
  orderIntakeStatusCounts: DropshipOpsCount[];
  listingPushJobStatusCounts: DropshipOpsCount[];
  trackingPushStatusCounts: DropshipOpsCount[];
  rmaStatusCounts: DropshipOpsCount[];
  notificationStatusCounts: DropshipOpsCount[];
}): DropshipOpsRiskBucket[] {
  return [
    {
      key: "store_connections_attention",
      label: "Store connections needing attention",
      severity: "error",
      count: sumCounts(input.storeConnectionStatusCounts, ["needs_reauth", "refresh_failed", "grace_period", "paused"]),
    },
    {
      key: "order_intake_blocked",
      label: "Order intake blocked",
      severity: "error",
      count: sumCounts(input.orderIntakeStatusCounts, ["failed", "exception", "rejected"]),
    },
    {
      key: "payment_holds",
      label: "Payment holds",
      severity: "warning",
      count: sumCounts(input.orderIntakeStatusCounts, ["payment_hold"]),
    },
    {
      key: "listing_push_failures",
      label: "Listing push failures",
      severity: "warning",
      count: sumCounts(input.listingPushJobStatusCounts, ["failed"]),
    },
    {
      key: "tracking_push_failures",
      label: "Tracking push failures",
      severity: "error",
      count: sumCounts(input.trackingPushStatusCounts, ["failed"]),
    },
    {
      key: "return_claim_attention",
      label: "Returns needing ops attention",
      severity: "warning",
      count: sumCounts(input.rmaStatusCounts, ["requested", "received", "inspecting"]),
    },
    {
      key: "notification_delivery_failures",
      label: "Notification delivery failures",
      severity: "warning",
      count: sumCounts(input.notificationStatusCounts, ["failed"]),
    },
  ];
}

function buildScopeFilters(
  input: { vendorId?: number; storeConnectionId?: number },
  options: { hasVendorId: boolean; hasStoreConnectionId: boolean },
): { whereSql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (input.vendorId && options.hasVendorId) {
    params.push(input.vendorId);
    clauses.push(`vendor_id = $${params.length}`);
  }
  if (input.storeConnectionId && options.hasStoreConnectionId) {
    params.push(input.storeConnectionId);
    clauses.push(`store_connection_id = $${params.length}`);
  }
  return {
    whereSql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

function buildAuditFilters(input: SearchDropshipAuditEventsInput): { whereSql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (input.vendorId) {
    params.push(input.vendorId);
    clauses.push(`ae.vendor_id = $${params.length}`);
  }
  if (input.storeConnectionId) {
    params.push(input.storeConnectionId);
    clauses.push(`ae.store_connection_id = $${params.length}`);
  }
  if (input.entityType) {
    params.push(input.entityType);
    clauses.push(`ae.entity_type = $${params.length}`);
  }
  if (input.entityId) {
    params.push(input.entityId);
    clauses.push(`ae.entity_id = $${params.length}`);
  }
  if (input.eventType) {
    params.push(input.eventType);
    clauses.push(`ae.event_type = $${params.length}`);
  }
  if (input.severity) {
    params.push(input.severity);
    clauses.push(`ae.severity = $${params.length}`);
  }
  if (input.createdFrom) {
    params.push(input.createdFrom);
    clauses.push(`ae.created_at >= $${params.length}`);
  }
  if (input.createdTo) {
    params.push(input.createdTo);
    clauses.push(`ae.created_at <= $${params.length}`);
  }
  if (input.search) {
    params.push(`%${input.search}%`);
    clauses.push(`(
      ae.event_type ILIKE $${params.length}
      OR ae.entity_type ILIKE $${params.length}
      OR ae.entity_id ILIKE $${params.length}
      OR ae.actor_id ILIKE $${params.length}
    )`);
  }
  return {
    whereSql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

function mapCountRow(row: CountRow): DropshipOpsCount {
  return {
    key: row.key,
    count: toNumber(row.count),
  };
}

function mapAuditEventRow(row: AuditEventRow): DropshipAuditEventRecord {
  return {
    auditEventId: row.id,
    vendorId: row.vendor_id,
    vendorBusinessName: row.vendor_business_name,
    vendorEmail: row.vendor_email,
    storeConnectionId: row.store_connection_id,
    storePlatform: row.store_platform,
    storeDisplayName: row.store_display_name,
    entityType: row.entity_type,
    entityId: row.entity_id,
    eventType: row.event_type,
    actorType: row.actor_type,
    actorId: row.actor_id,
    severity: row.severity,
    payload: row.payload ?? {},
    createdAt: row.created_at,
  };
}

function sumCounts(counts: DropshipOpsCount[], keys: string[]): number {
  const wanted = new Set(keys);
  return counts.reduce((sum, row) => wanted.has(row.key) ? sum + row.count : sum, 0);
}

function toNumber(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new DropshipError(
      "DROPSHIP_OPS_COUNT_OUT_OF_RANGE",
      "Dropship ops count is outside the safe integer range.",
      { value },
    );
  }
  return parsed;
}
