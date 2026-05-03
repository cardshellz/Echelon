import type { Pool } from "pg";
import { pool as defaultPool } from "../../../db";
import {
  buildDropshipSettingsSections,
  type DropshipAdminOpsOverview,
  type DropshipAuditEventRecord,
  type DropshipAuditEventSearchResult,
  type DropshipDogfoodReadinessCheck,
  type DropshipDogfoodReadinessItem,
  type DropshipDogfoodReadinessResult,
  type DropshipDogfoodReadinessStatus,
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

interface DogfoodReadinessRow {
  vendor_id: number;
  member_id: string;
  business_name: string | null;
  email: string | null;
  vendor_status: string;
  entitlement_status: string;
  store_connection_id: number | null;
  platform: string | null;
  store_status: string | null;
  setup_status: string | null;
  external_display_name: string | null;
  shop_domain: string | null;
  access_token_ref: string | null;
  updated_at: Date | null;
  default_warehouse_id_text: string | null;
  listing_config_id: number | null;
  listing_config_platform: string | null;
  listing_config_active: boolean | null;
  admin_catalog_include_rule_count: string | number;
  vendor_selection_include_rule_count: string | number;
  setup_open_blocker_count: string | number;
  setup_check_open_blocker_count: string | number;
  wallet_status: string | null;
  available_balance_cents: string | number | null;
  active_funding_method_count: string | number;
  auto_reload_enabled: boolean | null;
  notification_preference_count: string | number;
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

  async listDogfoodReadiness(
    input: Parameters<DropshipOpsSurfaceRepository["listDogfoodReadiness"]>[0],
  ): Promise<DropshipDogfoodReadinessResult> {
    const filters = buildDogfoodReadinessFilters(input);
    const result = await this.dbPool.query<DogfoodReadinessRow>(
      `${dogfoodReadinessSql()}
       ${filters.whereSql}
       ORDER BY v.updated_at DESC, v.id DESC, sc.updated_at DESC NULLS LAST, sc.id DESC NULLS LAST`,
      filters.params,
    );

    const allItems = result.rows.map(mapDogfoodReadinessRow);
    const filteredItems = input.status
      ? allItems.filter((item) => item.readinessStatus === input.status)
      : allItems;
    const offset = (input.page - 1) * input.limit;

    return {
      generatedAt: input.generatedAt,
      items: filteredItems.slice(offset, offset + input.limit),
      total: filteredItems.length,
      page: input.page,
      limit: input.limit,
      summary: summarizeDogfoodReadiness(allItems),
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

function dogfoodReadinessSql(): string {
  return `
    SELECT
      v.id AS vendor_id,
      v.member_id,
      v.business_name,
      v.email,
      v.status AS vendor_status,
      v.entitlement_status,
      sc.id AS store_connection_id,
      sc.platform,
      sc.status AS store_status,
      sc.setup_status,
      sc.external_display_name,
      sc.shop_domain,
      sc.access_token_ref,
      sc.updated_at,
      sc.config #>> '{orderProcessing,defaultWarehouseId}' AS default_warehouse_id_text,
      slc.id AS listing_config_id,
      slc.platform AS listing_config_platform,
      slc.is_active AS listing_config_active,
      COALESCE(admin_catalog.include_rule_count, 0) AS admin_catalog_include_rule_count,
      COALESCE(selection_rules.include_rule_count, 0) AS vendor_selection_include_rule_count,
      COALESCE(setup_blockers.open_blocker_count, 0) AS setup_open_blocker_count,
      COALESCE(setup_checks.open_blocker_count, 0) AS setup_check_open_blocker_count,
      wa.status AS wallet_status,
      wa.available_balance_cents,
      COALESCE(funding.active_funding_method_count, 0) AS active_funding_method_count,
      ars.enabled AS auto_reload_enabled,
      COALESCE(notification_prefs.preference_count, 0) AS notification_preference_count
    FROM dropship.dropship_vendors v
    LEFT JOIN dropship.dropship_store_connections sc ON sc.vendor_id = v.id
    LEFT JOIN dropship.dropship_store_listing_configs slc ON slc.store_connection_id = sc.id
    LEFT JOIN dropship.dropship_wallet_accounts wa ON wa.vendor_id = v.id
    LEFT JOIN dropship.dropship_auto_reload_settings ars ON ars.vendor_id = v.id
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS include_rule_count
      FROM dropship.dropship_catalog_rules cr
      WHERE cr.action = 'include'
        AND cr.is_active = true
        AND (cr.starts_at IS NULL OR cr.starts_at <= now())
        AND (cr.ends_at IS NULL OR cr.ends_at > now())
    ) admin_catalog ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS include_rule_count
      FROM dropship.dropship_vendor_selection_rules vsr
      WHERE vsr.vendor_id = v.id
        AND vsr.action = 'include'
        AND vsr.is_active = true
    ) selection_rules ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS open_blocker_count
      FROM dropship.dropship_setup_blockers sb
      WHERE sb.vendor_id = v.id
        AND (sb.store_connection_id = sc.id OR (sc.id IS NULL AND sb.store_connection_id IS NULL))
        AND sb.status <> 'resolved'
        AND sb.severity IN ('blocker', 'error')
    ) setup_blockers ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS open_blocker_count
      FROM dropship.dropship_store_setup_checks ssc
      WHERE ssc.vendor_id = v.id
        AND (ssc.store_connection_id = sc.id OR (sc.id IS NULL AND ssc.store_connection_id IS NULL))
        AND ssc.resolved_at IS NULL
        AND ssc.status NOT IN ('passed', 'ready', 'resolved')
        AND ssc.severity IN ('blocker', 'error')
    ) setup_checks ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS active_funding_method_count
      FROM dropship.dropship_funding_methods fm
      WHERE fm.vendor_id = v.id
        AND fm.status = 'active'
    ) funding ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS preference_count
      FROM dropship.dropship_notification_preferences np
      WHERE np.vendor_id = v.id
    ) notification_prefs ON true
  `;
}

function buildDogfoodReadinessFilters(input: {
  platform?: string;
  search?: string;
}): { whereSql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (input.platform) {
    params.push(input.platform);
    clauses.push(`sc.platform = $${params.length}`);
  }
  if (input.search) {
    params.push(`%${input.search.trim()}%`);
    clauses.push(`(
      v.member_id ILIKE $${params.length}
      OR v.business_name ILIKE $${params.length}
      OR v.email ILIKE $${params.length}
      OR sc.external_display_name ILIKE $${params.length}
      OR sc.shop_domain ILIKE $${params.length}
      OR sc.platform ILIKE $${params.length}
    )`);
  }
  return {
    whereSql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
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

function mapDogfoodReadinessRow(row: DogfoodReadinessRow): DropshipDogfoodReadinessItem {
  const adminCatalogIncludeRuleCount = toNumber(row.admin_catalog_include_rule_count);
  const vendorSelectionIncludeRuleCount = toNumber(row.vendor_selection_include_rule_count);
  const setupOpenBlockerCount = toNumber(row.setup_open_blocker_count) + toNumber(row.setup_check_open_blocker_count);
  const walletAvailableBalanceCents = toNumber(row.available_balance_cents ?? 0);
  const activeFundingMethodCount = toNumber(row.active_funding_method_count);
  const notificationPreferenceCount = toNumber(row.notification_preference_count);
  const defaultWarehouseId = parsePositiveIntegerOrNull(row.default_warehouse_id_text);
  const listingConfigActive = row.listing_config_id !== null
    && row.listing_config_active === true
    && row.listing_config_platform === row.platform;
  const checks = buildDogfoodChecks({
    row,
    defaultWarehouseId,
    adminCatalogIncludeRuleCount,
    vendorSelectionIncludeRuleCount,
    listingConfigActive,
    setupOpenBlockerCount,
    walletAvailableBalanceCents,
    activeFundingMethodCount,
    notificationPreferenceCount,
  });
  const blockerCount = checks.filter((check) => check.status === "blocked").length;
  const warningCount = checks.filter((check) => check.status === "warning").length;

  return {
    vendor: {
      vendorId: row.vendor_id,
      memberId: row.member_id,
      businessName: row.business_name,
      email: row.email,
      status: row.vendor_status,
      entitlementStatus: row.entitlement_status,
    },
    storeConnection: {
      storeConnectionId: row.store_connection_id,
      platform: row.platform,
      status: row.store_status,
      setupStatus: row.setup_status,
      externalDisplayName: row.external_display_name,
      shopDomain: row.shop_domain,
      updatedAt: row.updated_at,
    },
    readinessStatus: blockerCount > 0 ? "blocked" : warningCount > 0 ? "warning" : "ready",
    blockerCount,
    warningCount,
    checks,
    metrics: {
      defaultWarehouseId,
      adminCatalogIncludeRuleCount,
      vendorSelectionIncludeRuleCount,
      listingConfigActive,
      setupOpenBlockerCount,
      walletAvailableBalanceCents,
      activeFundingMethodCount,
      autoReloadEnabled: row.auto_reload_enabled === true,
      notificationPreferenceCount,
    },
  };
}

function buildDogfoodChecks(input: {
  row: DogfoodReadinessRow;
  defaultWarehouseId: number | null;
  adminCatalogIncludeRuleCount: number;
  vendorSelectionIncludeRuleCount: number;
  listingConfigActive: boolean;
  setupOpenBlockerCount: number;
  walletAvailableBalanceCents: number;
  activeFundingMethodCount: number;
  notificationPreferenceCount: number;
}): DropshipDogfoodReadinessCheck[] {
  return [
    {
      key: "vendor_entitlement",
      label: "Vendor entitlement",
      status: input.row.vendor_status === "active" && input.row.entitlement_status === "active" ? "ready" : "blocked",
      message: input.row.vendor_status === "active" && input.row.entitlement_status === "active"
        ? "Vendor and .ops entitlement are active."
        : `Vendor is ${input.row.vendor_status}; entitlement is ${input.row.entitlement_status}.`,
    },
    {
      key: "store_connection",
      label: "Store connection",
      status: input.row.store_connection_id !== null
        && input.row.store_status === "connected"
        && Boolean(input.row.access_token_ref)
        ? "ready"
        : "blocked",
      message: input.row.store_connection_id === null
        ? "No store connection exists."
        : input.row.store_status === "connected" && Boolean(input.row.access_token_ref)
          ? "Store connection is connected with an access token."
          : `Store is ${input.row.store_status ?? "missing"}; token ${input.row.access_token_ref ? "present" : "missing"}.`,
    },
    {
      key: "setup_checks",
      label: "Setup checks",
      status: input.row.setup_status === "ready" && input.setupOpenBlockerCount === 0 ? "ready" : "blocked",
      message: input.row.setup_status === "ready" && input.setupOpenBlockerCount === 0
        ? "Store setup checks are ready."
        : `Setup is ${input.row.setup_status ?? "missing"} with ${input.setupOpenBlockerCount} open blocker(s).`,
    },
    {
      key: "order_warehouse",
      label: "Order warehouse",
      status: input.defaultWarehouseId !== null ? "ready" : "blocked",
      message: input.defaultWarehouseId !== null
        ? `Default warehouse ${input.defaultWarehouseId} configured.`
        : "Default order-processing warehouse is missing.",
    },
    {
      key: "listing_config",
      label: "Listing configuration",
      status: input.listingConfigActive ? "ready" : "blocked",
      message: input.listingConfigActive
        ? "Store listing configuration is active."
        : "Store listing configuration is missing, inactive, or platform-mismatched.",
    },
    {
      key: "admin_catalog",
      label: "Admin catalog",
      status: input.adminCatalogIncludeRuleCount > 0 ? "ready" : "blocked",
      message: input.adminCatalogIncludeRuleCount > 0
        ? `${input.adminCatalogIncludeRuleCount} active include rule(s) expose catalog.`
        : "No active admin include rule exposes catalog.",
    },
    {
      key: "vendor_selection",
      label: "Vendor selection",
      status: input.vendorSelectionIncludeRuleCount > 0 ? "ready" : "blocked",
      message: input.vendorSelectionIncludeRuleCount > 0
        ? `${input.vendorSelectionIncludeRuleCount} active vendor include rule(s) exist.`
        : "Vendor has not selected any catalog.",
    },
    {
      key: "wallet",
      label: "Wallet",
      status: input.walletAvailableBalanceCents > 0 || input.activeFundingMethodCount > 0 ? "ready" : "warning",
      message: input.walletAvailableBalanceCents > 0
        ? `Wallet has ${input.walletAvailableBalanceCents} available cent(s).`
        : input.activeFundingMethodCount > 0
          ? `${input.activeFundingMethodCount} active funding method(s) exist.`
          : "Wallet has no available balance or active funding method.",
    },
    {
      key: "auto_reload",
      label: "Auto reload",
      status: input.row.auto_reload_enabled === true ? "ready" : "warning",
      message: input.row.auto_reload_enabled === true
        ? "Auto reload is enabled."
        : "Auto reload is disabled or not configured.",
    },
    {
      key: "notifications",
      label: "Notifications",
      status: input.notificationPreferenceCount > 0 ? "ready" : "warning",
      message: input.notificationPreferenceCount > 0
        ? `${input.notificationPreferenceCount} notification preference override(s) configured.`
        : "No notification preferences are configured.",
    },
  ];
}

function summarizeDogfoodReadiness(
  items: readonly DropshipDogfoodReadinessItem[],
): Array<{ status: DropshipDogfoodReadinessStatus; count: number }> {
  return [
    { status: "ready", count: items.filter((item) => item.readinessStatus === "ready").length },
    { status: "warning", count: items.filter((item) => item.readinessStatus === "warning").length },
    { status: "blocked", count: items.filter((item) => item.readinessStatus === "blocked").length },
  ];
}

function parsePositiveIntegerOrNull(value: string | null): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
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
