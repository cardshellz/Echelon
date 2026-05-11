import type { Pool } from "pg";
import { pool as defaultPool } from "../../../db";
import { DROPSHIP_LAUNCH_NOTIFICATION_PREFERENCES } from "../application/dropship-notification-service";
import {
  buildDropshipSettingsSections,
  type DropshipAdminOpsOverview,
  type DropshipAuditEventRecord,
  type DropshipAuditEventSearchResult,
  type DropshipDogfoodSmokeCandidate,
  type DropshipDogfoodReadinessCheck,
  type DropshipDogfoodReadinessItem,
  type DropshipDogfoodReadinessResult,
  type DropshipDogfoodReadinessStatus,
  type DropshipDogfoodSmokeResult,
  type DropshipDogfoodSmokeStage,
  type DropshipOpsCount,
  type DropshipOpsRiskBucket,
  type DropshipOpsSurfaceRepository,
  type DropshipVendorSettingsOverview,
  type GetDropshipAdminOpsOverviewInput,
  type SearchDropshipAuditEventsInput,
} from "../application/dropship-ops-surface-service";
import { DropshipError } from "../domain/errors";
import { isDropshipStoreConnectionLaunchReady } from "../domain/store-connection";

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
  active_stripe_funding_method_count: string | number;
  active_usdc_base_funding_method_count: string | number;
  auto_reload_funding_method_ready: boolean | null;
  notification_preference_count: string | number;
}

interface StoreConnectionRow {
  id: number;
  platform: string;
  status: string;
  setup_status: string;
  external_display_name: string | null;
  shop_domain: string | null;
  access_token_ref: string | null;
  refresh_token_ref: string | null;
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
  refresh_token_ref: string | null;
  token_expires_at: Date | null;
  updated_at: Date | null;
  dropship_oms_channel_id_text: string | null;
  dropship_oms_channel_count: string | number;
  default_warehouse_id_text: string | null;
  listing_config_id: number | null;
  listing_config_platform: string | null;
  listing_config_active: boolean | null;
  admin_catalog_include_rule_count: string | number;
  vendor_selection_include_rule_count: string | number;
  active_shipping_box_count: string | number;
  active_shipping_zone_rule_count: string | number;
  active_shipping_rate_table_count: string | number;
  active_shipping_rate_row_count: string | number;
  selected_variant_count: string | number;
  selected_package_profile_count: string | number;
  selected_variant_missing_package_profile_count: string | number;
  active_shipping_markup_policy_count: string | number;
  active_shipping_insurance_policy_count: string | number;
  active_return_policy_count: string | number;
  setup_open_blocker_count: string | number;
  setup_check_open_blocker_count: string | number;
  wallet_status: string | null;
  available_balance_cents: string | number | null;
  active_funding_method_count: string | number;
  active_stripe_funding_method_count: string | number;
  active_usdc_base_funding_method_count: string | number;
  auto_reload_enabled: boolean | null;
  auto_reload_funding_method_ready: boolean | null;
  notification_preference_count: string | number;
}

interface DogfoodSmokeRow {
  vendor_id: number;
  member_id: string;
  business_name: string | null;
  email: string | null;
  vendor_status: string;
  entitlement_status: string;
  store_connection_id: number;
  platform: string;
  store_status: string;
  setup_status: string;
  external_display_name: string | null;
  shop_domain: string | null;
  updated_at: Date;
  active_listing_count: string | number;
  latest_listing_id: number | null;
  latest_listing_status: string | null;
  latest_listing_external_id: string | null;
  latest_listing_pushed_at: Date | null;
  latest_listing_updated_at: Date | null;
  latest_listing_job_id: number | null;
  latest_listing_job_status: string | null;
  latest_listing_job_completed_at: Date | null;
  latest_listing_job_updated_at: Date | null;
  latest_listing_job_item_total: string | number | null;
  latest_listing_job_item_completed: string | number | null;
  latest_listing_job_item_failed: string | number | null;
  latest_intake_id: number | null;
  latest_intake_status: string | null;
  latest_intake_external_order_id: string | null;
  latest_intake_external_order_number: string | null;
  latest_intake_oms_order_id: string | number | null;
  latest_intake_received_at: Date | null;
  latest_intake_accepted_at: Date | null;
  latest_intake_updated_at: Date | null;
  latest_shipment_id: number | null;
  latest_shipment_status: string | null;
  latest_shipment_tracking_number: string | null;
  latest_shipment_carrier: string | null;
  latest_shipment_shipstation_order_id: number | null;
  latest_shipment_shipped_at: Date | null;
  latest_shipment_updated_at: Date | null;
  latest_tracking_push_id: number | null;
  latest_tracking_push_status: string | null;
  latest_tracking_push_external_fulfillment_id: string | null;
  latest_tracking_push_last_error_code: string | null;
  latest_tracking_push_last_error_message: string | null;
  latest_tracking_push_completed_at: Date | null;
  latest_tracking_push_updated_at: Date | null;
  total_count: string | number;
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
                COALESCE(fm.active_stripe_funding_method_count, 0) AS active_stripe_funding_method_count,
                COALESCE(fm.active_usdc_base_funding_method_count, 0) AS active_usdc_base_funding_method_count,
                COALESCE(auto_reload_funding.ready, false) AS auto_reload_funding_method_ready,
                COALESCE(np.notification_preference_count, 0) AS notification_preference_count
         FROM dropship.dropship_vendors v
         LEFT JOIN dropship.dropship_wallet_accounts wa ON wa.vendor_id = v.id
         LEFT JOIN dropship.dropship_auto_reload_settings ars ON ars.vendor_id = v.id
         LEFT JOIN LATERAL (
           SELECT
             COUNT(*) AS funding_method_count,
             COUNT(*) FILTER (
               WHERE rail IN ('stripe_card', 'stripe_ach')
                 AND provider_customer_id IS NOT NULL
                 AND provider_payment_method_id IS NOT NULL
             ) AS active_stripe_funding_method_count,
             COUNT(*) FILTER (
               WHERE rail = 'usdc_base'
                 AND usdc_wallet_address IS NOT NULL
             ) AS active_usdc_base_funding_method_count
           FROM dropship.dropship_funding_methods
           WHERE vendor_id = v.id
             AND status = 'active'
         ) fm ON true
         LEFT JOIN LATERAL (
           SELECT EXISTS (
             SELECT 1
             FROM dropship.dropship_funding_methods ar_fm
             WHERE ar_fm.id = ars.funding_method_id
               AND ar_fm.vendor_id = v.id
               AND ar_fm.status = 'active'
               AND ar_fm.rail IN ('stripe_card', 'stripe_ach')
               AND ar_fm.provider_customer_id IS NOT NULL
               AND ar_fm.provider_payment_method_id IS NOT NULL
           ) AS ready
         ) auto_reload_funding ON true
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
                shop_domain, access_token_ref, refresh_token_ref, updated_at
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
      hasAccessToken: row.access_token_ref !== null,
      hasRefreshToken: row.refresh_token_ref !== null,
      launchReady: isDropshipStoreConnectionLaunchReady({
        platform: row.platform,
        status: row.status,
        setupStatus: row.setup_status,
        hasAccessToken: row.access_token_ref !== null,
        hasRefreshToken: row.refresh_token_ref !== null,
      }),
      updatedAt: row.updated_at,
    }));
    const wallet = {
      availableBalanceCents: toNumber(vendor.available_balance_cents ?? 0),
      pendingBalanceCents: toNumber(vendor.pending_balance_cents ?? 0),
      autoReloadEnabled: vendor.auto_reload_enabled === true,
      fundingMethodCount: toNumber(vendor.funding_method_count),
      activeStripeFundingMethodCount: toNumber(vendor.active_stripe_funding_method_count),
      activeUsdcBaseFundingMethodCount: toNumber(vendor.active_usdc_base_funding_method_count),
      autoReloadFundingMethodReady: vendor.auto_reload_funding_method_ready === true,
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
      orderCancellationStatusCounts,
      listingPushJobStatusCounts,
      trackingPushStatusCounts,
      rmaStatusCounts,
      notificationStatusCounts,
      recentAuditEvents,
    ] = await Promise.all([
      this.countByStatus("dropship.dropship_vendors", "status", input, { hasVendorId: true, hasStoreConnectionId: false }),
      this.countByStatus("dropship.dropship_store_connections", "status", input, { hasVendorId: true, hasStoreConnectionId: true }),
      this.countByStatus("dropship.dropship_order_intake", "status", input, { hasVendorId: true, hasStoreConnectionId: true }),
      this.countByStatus("dropship.dropship_order_intake", "cancellation_status", input, {
        hasVendorId: true,
        hasStoreConnectionId: true,
        excludeNullStatus: true,
      }),
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
        orderCancellationStatusCounts,
        listingPushJobStatusCounts,
        trackingPushStatusCounts,
        rmaStatusCounts,
        notificationStatusCounts,
      }),
      vendorStatusCounts,
      storeConnectionStatusCounts,
      orderIntakeStatusCounts,
      orderCancellationStatusCounts,
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
    const launchGateResult = filters.whereSql
      ? await this.dbPool.query<DogfoodReadinessRow>(
          `${dogfoodReadinessSql()}
           ORDER BY v.updated_at DESC, v.id DESC, sc.updated_at DESC NULLS LAST, sc.id DESC NULLS LAST`,
          [],
        )
      : result;

    const allItems = result.rows.map(mapDogfoodReadinessRow);
    const launchGateItems = launchGateResult.rows.map(mapDogfoodReadinessRow);
    const filteredItems = input.status
      ? allItems.filter((item) => item.readinessStatus === input.status)
      : allItems;
    const offset = (input.page - 1) * input.limit;

    return {
      generatedAt: input.generatedAt,
      items: filteredItems.slice(offset, offset + input.limit),
      launchGateItems,
      total: filteredItems.length,
      page: input.page,
      limit: input.limit,
      summary: summarizeDogfoodReadiness(allItems),
      systemChecks: [],
    };
  }

  async listDogfoodSmokeCandidates(
    input: Parameters<DropshipOpsSurfaceRepository["listDogfoodSmokeCandidates"]>[0],
  ): Promise<DropshipDogfoodSmokeResult> {
    const filters = buildDogfoodSmokeFilters(input);
    const result = await this.dbPool.query<DogfoodSmokeRow>(
      `${dogfoodSmokeSql()}
       ${filters.whereSql}
       ORDER BY latest_activity_at DESC NULLS LAST, sc.updated_at DESC, sc.id DESC
       LIMIT $${filters.params.length + 1}`,
      [...filters.params, input.limit],
    );
    const candidates = result.rows.map(mapDogfoodSmokeRow);
    const readyCandidateCount = candidates.filter((candidate) => candidate.status === "ready").length;
    const warningCandidateCount = candidates.filter((candidate) => candidate.status === "warning").length;
    const blockedCandidateCount = candidates.filter((candidate) => candidate.status === "blocked").length;

    return {
      generatedAt: input.generatedAt,
      candidates,
      total: toNumber(result.rows[0]?.total_count ?? 0),
      readyCandidateCount,
      warningCandidateCount,
      blockedCandidateCount,
      message: buildDogfoodSmokeMessage({
        readyCandidateCount,
        warningCandidateCount,
        blockedCandidateCount,
      }),
    };
  }

  private async countByStatus(
    tableName: string,
    statusColumn: string,
    input: { vendorId?: number; storeConnectionId?: number },
    options: { hasVendorId: boolean; hasStoreConnectionId: boolean; excludeNullStatus?: boolean },
  ): Promise<DropshipOpsCount[]> {
    const filters = buildScopeFilters(input, options);
    const whereSql = appendCountStatusFilter(filters.whereSql, `${statusColumn} IS NOT NULL`, options.excludeNullStatus === true);
    const result = await this.dbPool.query<CountRow>(
      `SELECT ${statusColumn} AS key, COUNT(*) AS count
       FROM ${tableName}
       ${whereSql}
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
      sc.refresh_token_ref,
      sc.token_expires_at,
      sc.updated_at,
      dropship_oms.channel_id::text AS dropship_oms_channel_id_text,
      COALESCE(dropship_oms.channel_count, 0) AS dropship_oms_channel_count,
      store_defaults.default_warehouse_id::text AS default_warehouse_id_text,
      slc.id AS listing_config_id,
      slc.platform AS listing_config_platform,
      slc.is_active AS listing_config_active,
      COALESCE(admin_catalog.include_rule_count, 0) AS admin_catalog_include_rule_count,
      COALESCE(selection_rules.include_rule_count, 0) AS vendor_selection_include_rule_count,
      COALESCE(shipping_boxes.active_box_count, 0) AS active_shipping_box_count,
      COALESCE(shipping_zones.active_zone_rule_count, 0) AS active_shipping_zone_rule_count,
      COALESCE(shipping_rates.active_rate_table_count, 0) AS active_shipping_rate_table_count,
      COALESCE(shipping_rates.active_rate_row_count, 0) AS active_shipping_rate_row_count,
      COALESCE(package_readiness.selected_variant_count, 0) AS selected_variant_count,
      COALESCE(package_readiness.selected_package_profile_count, 0) AS selected_package_profile_count,
      COALESCE(package_readiness.selected_variant_missing_package_profile_count, 0) AS selected_variant_missing_package_profile_count,
      COALESCE(shipping_policies.active_markup_policy_count, 0) AS active_shipping_markup_policy_count,
      COALESCE(shipping_policies.active_insurance_policy_count, 0) AS active_shipping_insurance_policy_count,
      COALESCE(return_policies.active_return_policy_count, 0) AS active_return_policy_count,
      COALESCE(setup_blockers.open_blocker_count, 0) AS setup_open_blocker_count,
      COALESCE(setup_checks.open_blocker_count, 0) AS setup_check_open_blocker_count,
      wa.status AS wallet_status,
      wa.available_balance_cents,
      COALESCE(funding.active_funding_method_count, 0) AS active_funding_method_count,
      COALESCE(funding.active_stripe_funding_method_count, 0) AS active_stripe_funding_method_count,
      COALESCE(funding.active_usdc_base_funding_method_count, 0) AS active_usdc_base_funding_method_count,
      ars.enabled AS auto_reload_enabled,
      COALESCE(auto_reload_funding.ready, false) AS auto_reload_funding_method_ready,
      COALESCE(notification_prefs.preference_count, 0) AS notification_preference_count
    FROM dropship.dropship_vendors v
    LEFT JOIN dropship.dropship_store_connections sc ON sc.vendor_id = v.id
      AND sc.status IN ('connected', 'needs_reauth', 'refresh_failed', 'grace_period', 'paused')
    LEFT JOIN dropship.dropship_store_listing_configs slc ON slc.store_connection_id = sc.id
    LEFT JOIN dropship.dropship_wallet_accounts wa ON wa.vendor_id = v.id
    LEFT JOIN dropship.dropship_auto_reload_settings ars ON ars.vendor_id = v.id
    LEFT JOIN LATERAL (
      SELECT MIN(marked_channels.id) AS channel_id,
             COUNT(*) AS channel_count
      FROM (
        SELECT DISTINCT c.id
        FROM channels.channels c
        WHERE c.status = 'active'
          AND (
            LOWER(COALESCE(c.shipping_config #>> '{dropship,role}', '')) = 'oms'
            OR COALESCE(c.shipping_config #>> '{dropship,omsChannel}', 'false') = 'true'
            OR EXISTS (
              SELECT 1
              FROM channels.channel_connections cc
              WHERE cc.channel_id = c.id
                AND (
                  LOWER(COALESCE(cc.metadata #>> '{dropship,role}', '')) = 'oms'
                  OR COALESCE(cc.metadata #>> '{features,dropshipOms}', 'false') = 'true'
                  OR COALESCE(cc.metadata #>> '{features,dropship_oms}', 'false') = 'true'
                )
            )
          )
      ) marked_channels
    ) dropship_oms ON true
    LEFT JOIN LATERAL (
      SELECT
        CASE
          WHEN (sc.config #>> '{orderProcessing,defaultWarehouseId}') ~ '^[1-9][0-9]*$'
            THEN (sc.config #>> '{orderProcessing,defaultWarehouseId}')::integer
          ELSE NULL
        END AS default_warehouse_id
    ) store_defaults ON true
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
      SELECT COUNT(*) AS active_box_count
      FROM dropship.dropship_box_catalog bc
      WHERE bc.is_active = true
    ) shipping_boxes ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS active_zone_rule_count
      FROM dropship.dropship_zone_rules zr
      WHERE store_defaults.default_warehouse_id IS NOT NULL
        AND zr.origin_warehouse_id = store_defaults.default_warehouse_id
        AND zr.is_active = true
    ) shipping_zones ON true
    LEFT JOIN LATERAL (
      SELECT
        COUNT(DISTINCT rt.id) AS active_rate_table_count,
        COUNT(rr.id) AS active_rate_row_count
      FROM dropship.dropship_rate_tables rt
      INNER JOIN dropship.dropship_rate_table_rows rr ON rr.rate_table_id = rt.id
      WHERE store_defaults.default_warehouse_id IS NOT NULL
        AND rt.status = 'active'
        AND rt.effective_from <= now()
        AND (rt.effective_to IS NULL OR rt.effective_to > now())
        AND (rr.warehouse_id = store_defaults.default_warehouse_id OR rr.warehouse_id IS NULL)
        AND EXISTS (
          SELECT 1
          FROM dropship.dropship_zone_rules zr_rate
          WHERE zr_rate.origin_warehouse_id = store_defaults.default_warehouse_id
            AND zr_rate.is_active = true
            AND zr_rate.zone = rr.destination_zone
        )
    ) shipping_rates ON true
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) AS selected_variant_count,
        COUNT(*) FILTER (WHERE selected_variants.has_active_package_profile) AS selected_package_profile_count,
        COUNT(*) FILTER (WHERE NOT selected_variants.has_active_package_profile) AS selected_variant_missing_package_profile_count
      FROM (
        SELECT
          pv.id AS product_variant_id,
          EXISTS (
            SELECT 1
            FROM dropship.dropship_package_profiles pp
            WHERE pp.product_variant_id = pv.id
              AND pp.is_active = true
          ) AS has_active_package_profile
        FROM catalog.product_variants pv
        INNER JOIN catalog.products p ON p.id = pv.product_id
        WHERE pv.is_active = true
          AND p.is_active = true
          AND EXISTS (
            SELECT 1
            FROM dropship.dropship_catalog_rules cr
            WHERE cr.action = 'include'
              AND cr.is_active = true
              AND (cr.starts_at IS NULL OR cr.starts_at <= now())
              AND (cr.ends_at IS NULL OR cr.ends_at > now())
              AND ${catalogVariantRuleMatchSql("cr")}
          )
          AND NOT EXISTS (
            SELECT 1
            FROM dropship.dropship_catalog_rules cr
            WHERE cr.action = 'exclude'
              AND cr.is_active = true
              AND (cr.starts_at IS NULL OR cr.starts_at <= now())
              AND (cr.ends_at IS NULL OR cr.ends_at > now())
              AND ${catalogVariantRuleMatchSql("cr")}
          )
          AND EXISTS (
            SELECT 1
            FROM dropship.dropship_vendor_selection_rules vsr
            WHERE vsr.vendor_id = v.id
              AND vsr.action = 'include'
              AND vsr.is_active = true
              AND ${catalogVariantRuleMatchSql("vsr")}
          )
          AND NOT EXISTS (
            SELECT 1
            FROM dropship.dropship_vendor_selection_rules vsr
            WHERE vsr.vendor_id = v.id
              AND vsr.action = 'exclude'
              AND vsr.is_active = true
              AND ${catalogVariantRuleMatchSql("vsr")}
          )
      ) selected_variants
    ) package_readiness ON true
    LEFT JOIN LATERAL (
      SELECT
        (
          SELECT COUNT(*)
          FROM dropship.dropship_shipping_markup_config smc
          WHERE smc.is_active = true
            AND smc.effective_from <= now()
            AND (smc.effective_to IS NULL OR smc.effective_to > now())
        ) AS active_markup_policy_count,
        (
          SELECT COUNT(*)
          FROM dropship.dropship_insurance_pool_config ipc
          WHERE ipc.is_active = true
            AND ipc.effective_from <= now()
            AND (ipc.effective_to IS NULL OR ipc.effective_to > now())
        ) AS active_insurance_policy_count
    ) shipping_policies ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS active_return_policy_count
      FROM dropship.dropship_return_policy_config rpc
      WHERE rpc.is_active = true
        AND rpc.effective_from <= now()
        AND (rpc.effective_to IS NULL OR rpc.effective_to > now())
    ) return_policies ON true
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
      SELECT
        COUNT(*) AS active_funding_method_count,
        COUNT(*) FILTER (
          WHERE fm.rail IN ('stripe_card', 'stripe_ach')
            AND fm.provider_customer_id IS NOT NULL
            AND fm.provider_payment_method_id IS NOT NULL
        ) AS active_stripe_funding_method_count,
        COUNT(*) FILTER (
          WHERE fm.rail = 'usdc_base'
            AND fm.usdc_wallet_address IS NOT NULL
        ) AS active_usdc_base_funding_method_count
      FROM dropship.dropship_funding_methods fm
      WHERE fm.vendor_id = v.id
        AND fm.status = 'active'
    ) funding ON true
    LEFT JOIN LATERAL (
      SELECT EXISTS (
        SELECT 1
        FROM dropship.dropship_funding_methods fm
        WHERE fm.id = ars.funding_method_id
          AND fm.vendor_id = v.id
          AND fm.status = 'active'
          AND fm.rail IN ('stripe_card', 'stripe_ach')
          AND fm.provider_customer_id IS NOT NULL
          AND fm.provider_payment_method_id IS NOT NULL
      ) AS ready
    ) auto_reload_funding ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS preference_count
      FROM dropship.dropship_notification_preferences np
      WHERE np.vendor_id = v.id
    ) notification_prefs ON true
  `;
}

function dogfoodSmokeSql(): string {
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
      sc.updated_at,
      COALESCE(listing_counts.active_listing_count, 0) AS active_listing_count,
      latest_listing.id AS latest_listing_id,
      latest_listing.status AS latest_listing_status,
      latest_listing.external_listing_id AS latest_listing_external_id,
      latest_listing.last_pushed_at AS latest_listing_pushed_at,
      latest_listing.updated_at AS latest_listing_updated_at,
      latest_listing_job.id AS latest_listing_job_id,
      latest_listing_job.status AS latest_listing_job_status,
      latest_listing_job.completed_at AS latest_listing_job_completed_at,
      latest_listing_job.updated_at AS latest_listing_job_updated_at,
      COALESCE(latest_listing_job.item_total, 0) AS latest_listing_job_item_total,
      COALESCE(latest_listing_job.item_completed, 0) AS latest_listing_job_item_completed,
      COALESCE(latest_listing_job.item_failed, 0) AS latest_listing_job_item_failed,
      latest_intake.id AS latest_intake_id,
      latest_intake.status AS latest_intake_status,
      latest_intake.external_order_id AS latest_intake_external_order_id,
      latest_intake.external_order_number AS latest_intake_external_order_number,
      latest_intake.oms_order_id AS latest_intake_oms_order_id,
      latest_intake.received_at AS latest_intake_received_at,
      latest_intake.accepted_at AS latest_intake_accepted_at,
      latest_intake.updated_at AS latest_intake_updated_at,
      latest_shipment.id AS latest_shipment_id,
      latest_shipment.status AS latest_shipment_status,
      latest_shipment.tracking_number AS latest_shipment_tracking_number,
      latest_shipment.carrier AS latest_shipment_carrier,
      latest_shipment.shipstation_order_id AS latest_shipment_shipstation_order_id,
      latest_shipment.shipped_at AS latest_shipment_shipped_at,
      latest_shipment.updated_at AS latest_shipment_updated_at,
      latest_tracking_push.id AS latest_tracking_push_id,
      latest_tracking_push.status AS latest_tracking_push_status,
      latest_tracking_push.external_fulfillment_id AS latest_tracking_push_external_fulfillment_id,
      latest_tracking_push.last_error_code AS latest_tracking_push_last_error_code,
      latest_tracking_push.last_error_message AS latest_tracking_push_last_error_message,
      latest_tracking_push.completed_at AS latest_tracking_push_completed_at,
      latest_tracking_push.updated_at AS latest_tracking_push_updated_at,
      GREATEST(
        latest_listing.updated_at,
        latest_listing_job.updated_at,
        latest_intake.updated_at,
        latest_shipment.updated_at,
        latest_tracking_push.updated_at
      ) AS latest_activity_at,
      COUNT(*) OVER() AS total_count
    FROM dropship.dropship_vendors v
    INNER JOIN dropship.dropship_store_connections sc ON sc.vendor_id = v.id
      AND sc.status IN ('connected', 'needs_reauth', 'refresh_failed', 'grace_period', 'paused')
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS active_listing_count
      FROM dropship.dropship_vendor_listings l
      WHERE l.vendor_id = v.id
        AND l.store_connection_id = sc.id
        AND l.status = 'active'
    ) listing_counts ON true
    LEFT JOIN LATERAL (
      SELECT l.id, l.status, l.external_listing_id, l.last_pushed_at, l.updated_at
      FROM dropship.dropship_vendor_listings l
      WHERE l.vendor_id = v.id
        AND l.store_connection_id = sc.id
      ORDER BY l.updated_at DESC, l.id DESC
      LIMIT 1
    ) latest_listing ON true
    LEFT JOIN LATERAL (
      SELECT
        j.id,
        j.status,
        j.completed_at,
        j.updated_at,
        COALESCE(items.item_total, 0) AS item_total,
        COALESCE(items.item_completed, 0) AS item_completed,
        COALESCE(items.item_failed, 0) AS item_failed
      FROM dropship.dropship_listing_push_jobs j
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) AS item_total,
          COUNT(*) FILTER (WHERE i.status = 'completed') AS item_completed,
          COUNT(*) FILTER (WHERE i.status IN ('failed', 'blocked')) AS item_failed
        FROM dropship.dropship_listing_push_job_items i
        WHERE i.job_id = j.id
      ) items ON true
      WHERE j.vendor_id = v.id
        AND j.store_connection_id = sc.id
      ORDER BY j.updated_at DESC, j.id DESC
      LIMIT 1
    ) latest_listing_job ON true
    LEFT JOIN LATERAL (
      SELECT oi.id, oi.status, oi.external_order_id, oi.external_order_number,
             oi.oms_order_id, oi.received_at, oi.accepted_at, oi.updated_at
      FROM dropship.dropship_order_intake oi
      WHERE oi.vendor_id = v.id
        AND oi.store_connection_id = sc.id
      ORDER BY oi.updated_at DESC, oi.id DESC
      LIMIT 1
    ) latest_intake ON true
    LEFT JOIN LATERAL (
      SELECT os.id, os.status, os.tracking_number, os.carrier,
             os.shipstation_order_id, os.shipped_at, os.updated_at
      FROM wms.outbound_shipments os
      WHERE latest_intake.oms_order_id IS NOT NULL
        AND os.order_id = latest_intake.oms_order_id
      ORDER BY os.updated_at DESC, os.id DESC
      LIMIT 1
    ) latest_shipment ON true
    LEFT JOIN LATERAL (
      SELECT tp.id, tp.status, tp.external_fulfillment_id, tp.last_error_code,
             tp.last_error_message, tp.completed_at, tp.updated_at
      FROM dropship.dropship_marketplace_tracking_pushes tp
      WHERE tp.vendor_id = v.id
        AND tp.store_connection_id = sc.id
        AND (latest_intake.id IS NULL OR tp.intake_id = latest_intake.id)
      ORDER BY tp.updated_at DESC, tp.id DESC
      LIMIT 1
    ) latest_tracking_push ON true
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

function buildDogfoodSmokeFilters(input: {
  vendorId?: number;
  storeConnectionId?: number;
  platform?: string;
  search?: string;
}): { whereSql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (input.vendorId) {
    params.push(input.vendorId);
    clauses.push(`v.id = $${params.length}`);
  }
  if (input.storeConnectionId) {
    params.push(input.storeConnectionId);
    clauses.push(`sc.id = $${params.length}`);
  }
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
      OR latest_intake.external_order_id ILIKE $${params.length}
      OR latest_intake.external_order_number ILIKE $${params.length}
      OR latest_shipment.tracking_number ILIKE $${params.length}
    )`);
  }
  return {
    whereSql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

function catalogVariantRuleMatchSql(ruleAlias: string): string {
  return `(
    ${ruleAlias}.scope_type = 'catalog'
    OR (
      ${ruleAlias}.scope_type = 'product_line'
      AND ${ruleAlias}.product_line_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM catalog.product_line_products plp_match
        WHERE plp_match.product_id = p.id
          AND plp_match.product_line_id = ${ruleAlias}.product_line_id
      )
    )
    OR (
      ${ruleAlias}.scope_type = 'category'
      AND NULLIF(LOWER(BTRIM(${ruleAlias}.category)), '') = NULLIF(LOWER(BTRIM(p.category)), '')
    )
    OR (${ruleAlias}.scope_type = 'product' AND ${ruleAlias}.product_id = p.id)
    OR (${ruleAlias}.scope_type = 'variant' AND ${ruleAlias}.product_variant_id = pv.id)
  )`;
}

function buildRiskBuckets(input: {
  storeConnectionStatusCounts: DropshipOpsCount[];
  orderIntakeStatusCounts: DropshipOpsCount[];
  orderCancellationStatusCounts: DropshipOpsCount[];
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
      key: "marketplace_cancellation_failures",
      label: "Marketplace cancellation failures",
      severity: "error",
      count: sumCounts(input.orderCancellationStatusCounts, ["marketplace_cancellation_failed"]),
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
  const dropshipOmsChannelId = parsePositiveIntegerOrNull(row.dropship_oms_channel_id_text);
  const dropshipOmsChannelCount = toNumber(row.dropship_oms_channel_count);
  const adminCatalogIncludeRuleCount = toNumber(row.admin_catalog_include_rule_count);
  const vendorSelectionIncludeRuleCount = toNumber(row.vendor_selection_include_rule_count);
  const activeShippingBoxCount = toNumber(row.active_shipping_box_count);
  const activeShippingZoneRuleCount = toNumber(row.active_shipping_zone_rule_count);
  const activeShippingRateTableCount = toNumber(row.active_shipping_rate_table_count);
  const activeShippingRateRowCount = toNumber(row.active_shipping_rate_row_count);
  const selectedVariantCount = toNumber(row.selected_variant_count);
  const selectedPackageProfileCount = toNumber(row.selected_package_profile_count);
  const selectedVariantMissingPackageProfileCount = toNumber(row.selected_variant_missing_package_profile_count);
  const activeShippingMarkupPolicyCount = toNumber(row.active_shipping_markup_policy_count);
  const activeShippingInsurancePolicyCount = toNumber(row.active_shipping_insurance_policy_count);
  const activeReturnPolicyCount = toNumber(row.active_return_policy_count);
  const setupOpenBlockerCount = toNumber(row.setup_open_blocker_count) + toNumber(row.setup_check_open_blocker_count);
  const walletAvailableBalanceCents = toNumber(row.available_balance_cents ?? 0);
  const activeFundingMethodCount = toNumber(row.active_funding_method_count);
  const activeStripeFundingMethodCount = toNumber(row.active_stripe_funding_method_count);
  const activeUsdcBaseFundingMethodCount = toNumber(row.active_usdc_base_funding_method_count);
  const autoReloadFundingMethodReady = row.auto_reload_funding_method_ready === true;
  const notificationPreferenceCount = toNumber(row.notification_preference_count);
  const defaultWarehouseId = parsePositiveIntegerOrNull(row.default_warehouse_id_text);
  const listingConfigActive = row.listing_config_id !== null
    && row.listing_config_active === true
    && row.listing_config_platform === row.platform;
  const checks = buildDogfoodChecks({
    row,
    dropshipOmsChannelId,
    dropshipOmsChannelCount,
    defaultWarehouseId,
    adminCatalogIncludeRuleCount,
    vendorSelectionIncludeRuleCount,
    activeShippingBoxCount,
    activeShippingZoneRuleCount,
    activeShippingRateTableCount,
    activeShippingRateRowCount,
    selectedVariantCount,
    selectedPackageProfileCount,
    selectedVariantMissingPackageProfileCount,
    activeShippingMarkupPolicyCount,
    activeShippingInsurancePolicyCount,
    activeReturnPolicyCount,
    listingConfigActive,
    setupOpenBlockerCount,
    walletAvailableBalanceCents,
    activeFundingMethodCount,
    activeStripeFundingMethodCount,
    activeUsdcBaseFundingMethodCount,
    autoReloadFundingMethodReady,
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
      dropshipOmsChannelId,
      dropshipOmsChannelCount,
      defaultWarehouseId,
      adminCatalogIncludeRuleCount,
      vendorSelectionIncludeRuleCount,
      activeShippingBoxCount,
      activeShippingZoneRuleCount,
      activeShippingRateTableCount,
      activeShippingRateRowCount,
      selectedVariantCount,
      selectedPackageProfileCount,
      selectedVariantMissingPackageProfileCount,
      activeShippingMarkupPolicyCount,
      activeShippingInsurancePolicyCount,
      activeReturnPolicyCount,
      listingConfigActive,
      setupOpenBlockerCount,
      walletAvailableBalanceCents,
      activeFundingMethodCount,
      activeStripeFundingMethodCount,
      activeUsdcBaseFundingMethodCount,
      autoReloadEnabled: row.auto_reload_enabled === true,
      autoReloadFundingMethodReady,
      notificationPreferenceCount,
    },
  };
}

function mapDogfoodSmokeRow(row: DogfoodSmokeRow): DropshipDogfoodSmokeCandidate {
  const stages = [
    buildListingSmokeStage(row),
    buildOrderIntakeSmokeStage(row),
    buildFulfillmentSmokeStage(row),
    buildTrackingSmokeStage(row),
  ];
  const status = summarizeStageStatus(stages);
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
    status,
    message: buildDogfoodSmokeCandidateMessage(status),
    stages,
    references: {
      latestListingId: row.latest_listing_id,
      latestListingJobId: row.latest_listing_job_id,
      latestIntakeId: row.latest_intake_id,
      latestOmsOrderId: parsePositiveIntegerOrNull(row.latest_intake_oms_order_id),
      latestWmsShipmentId: row.latest_shipment_id,
      latestTrackingPushId: row.latest_tracking_push_id,
    },
    lastActivityAt: maxDate([
      row.latest_listing_updated_at,
      row.latest_listing_job_updated_at,
      row.latest_intake_updated_at,
      row.latest_shipment_updated_at,
      row.latest_tracking_push_updated_at,
    ]),
  };
}

function buildListingSmokeStage(row: DogfoodSmokeRow): DropshipDogfoodSmokeStage {
  const activeListingCount = toNumber(row.active_listing_count);
  const itemFailed = toNumber(row.latest_listing_job_item_failed ?? 0);
  const itemCompleted = toNumber(row.latest_listing_job_item_completed ?? 0);
  const itemTotal = toNumber(row.latest_listing_job_item_total ?? 0);
  const evidence = [
    `${activeListingCount} active marketplace listing(s).`,
    row.latest_listing_id
      ? `Latest listing ${row.latest_listing_id}: ${row.latest_listing_status}.`
      : null,
    row.latest_listing_job_id
      ? `Latest push job ${row.latest_listing_job_id}: ${row.latest_listing_job_status}; ${itemCompleted}/${itemTotal} item(s) completed, ${itemFailed} failed or blocked.`
      : null,
  ].filter((entry): entry is string => Boolean(entry));

  if (row.latest_listing_job_status === "failed" || itemFailed > 0 || row.latest_listing_status === "failed" || row.latest_listing_status === "blocked") {
    return {
      key: "listing",
      label: "Listing push",
      status: "blocked",
      message: "Latest listing evidence has failed or blocked work.",
      evidence,
      latestAt: maxDate([row.latest_listing_updated_at, row.latest_listing_job_updated_at]),
    };
  }
  if (activeListingCount > 0) {
    return {
      key: "listing",
      label: "Listing push",
      status: "ready",
      message: "At least one active marketplace listing exists for this store.",
      evidence,
      latestAt: maxDate([row.latest_listing_pushed_at, row.latest_listing_updated_at, row.latest_listing_job_completed_at]),
    };
  }
  if (row.latest_listing_job_status === "queued" || row.latest_listing_job_status === "processing") {
    return {
      key: "listing",
      label: "Listing push",
      status: "warning",
      message: "Listing push work is still queued or processing.",
      evidence,
      latestAt: row.latest_listing_job_updated_at,
    };
  }
  return {
    key: "listing",
    label: "Listing push",
    status: "warning",
    message: "No active listing evidence exists yet.",
    evidence: evidence.length > 0 ? evidence : ["No listing or listing push job has been recorded for this store."],
    latestAt: maxDate([row.latest_listing_updated_at, row.latest_listing_job_updated_at]),
  };
}

function buildOrderIntakeSmokeStage(row: DogfoodSmokeRow): DropshipDogfoodSmokeStage {
  const status = row.latest_intake_status;
  const evidence = row.latest_intake_id
    ? [
        `Latest intake ${row.latest_intake_id}: ${status}.`,
        row.latest_intake_external_order_number
          ? `Marketplace order ${row.latest_intake_external_order_number}.`
          : `Marketplace order ${row.latest_intake_external_order_id}.`,
        row.latest_intake_oms_order_id ? `OMS order ${row.latest_intake_oms_order_id}.` : "No OMS order linked yet.",
      ]
    : ["No marketplace order intake has been recorded for this store."];

  if (status === "accepted" && row.latest_intake_oms_order_id !== null) {
    return {
      key: "order_intake",
      label: "Order intake",
      status: "ready",
      message: "Latest marketplace order intake accepted and linked to OMS.",
      evidence,
      latestAt: maxDate([row.latest_intake_accepted_at, row.latest_intake_updated_at]),
    };
  }
  if (status === "failed" || status === "exception" || status === "rejected" || status === "cancelled") {
    return {
      key: "order_intake",
      label: "Order intake",
      status: "blocked",
      message: "Latest marketplace order intake is not usable for dogfood smoke.",
      evidence,
      latestAt: row.latest_intake_updated_at,
    };
  }
  return {
    key: "order_intake",
    label: "Order intake",
    status: "warning",
    message: row.latest_intake_id
      ? "Latest marketplace order intake has not reached accepted OMS state."
      : "No order intake evidence exists yet.",
    evidence,
    latestAt: row.latest_intake_updated_at,
  };
}

function buildFulfillmentSmokeStage(row: DogfoodSmokeRow): DropshipDogfoodSmokeStage {
  const evidence = row.latest_shipment_id
    ? [
        `Latest WMS shipment ${row.latest_shipment_id}: ${row.latest_shipment_status}.`,
        row.latest_shipment_shipstation_order_id ? `ShipStation order ${row.latest_shipment_shipstation_order_id}.` : "No ShipStation order id linked.",
        row.latest_shipment_tracking_number
          ? `Tracking ${row.latest_shipment_carrier ?? "carrier"} ${row.latest_shipment_tracking_number}.`
          : "No shipment tracking number recorded.",
      ]
    : ["No WMS shipment has been recorded for the latest intake."];

  if (row.latest_shipment_status === "shipped" && row.latest_shipment_tracking_number) {
    return {
      key: "fulfillment",
      label: "WMS shipment",
      status: "ready",
      message: "Latest WMS shipment is shipped with tracking.",
      evidence,
      latestAt: maxDate([row.latest_shipment_shipped_at, row.latest_shipment_updated_at]),
    };
  }
  if (row.latest_shipment_status === "cancelled" || row.latest_shipment_status === "voided" || row.latest_shipment_status === "lost" || row.latest_shipment_status === "returned") {
    return {
      key: "fulfillment",
      label: "WMS shipment",
      status: "blocked",
      message: "Latest WMS shipment ended in a terminal exception state.",
      evidence,
      latestAt: row.latest_shipment_updated_at,
    };
  }
  return {
    key: "fulfillment",
    label: "WMS shipment",
    status: "warning",
    message: row.latest_shipment_id
      ? "Latest WMS shipment has not shipped with tracking yet."
      : "No shipment evidence exists yet.",
    evidence,
    latestAt: row.latest_shipment_updated_at,
  };
}

function buildTrackingSmokeStage(row: DogfoodSmokeRow): DropshipDogfoodSmokeStage {
  const evidence = row.latest_tracking_push_id
    ? [
        `Latest tracking push ${row.latest_tracking_push_id}: ${row.latest_tracking_push_status}.`,
        row.latest_tracking_push_external_fulfillment_id
          ? `External fulfillment ${row.latest_tracking_push_external_fulfillment_id}.`
          : "No external fulfillment id recorded.",
        row.latest_tracking_push_last_error_code
          ? `${row.latest_tracking_push_last_error_code}: ${row.latest_tracking_push_last_error_message ?? "No error message."}`
          : null,
      ].filter((entry): entry is string => Boolean(entry))
    : ["No marketplace tracking push has been recorded for the latest intake."];

  if (row.latest_tracking_push_status === "succeeded") {
    return {
      key: "tracking",
      label: "Marketplace tracking",
      status: "ready",
      message: "Latest marketplace tracking push succeeded.",
      evidence,
      latestAt: maxDate([row.latest_tracking_push_completed_at, row.latest_tracking_push_updated_at]),
    };
  }
  if (row.latest_tracking_push_status === "failed") {
    return {
      key: "tracking",
      label: "Marketplace tracking",
      status: "blocked",
      message: "Latest marketplace tracking push failed.",
      evidence,
      latestAt: row.latest_tracking_push_updated_at,
    };
  }
  if (!row.latest_tracking_push_id && row.latest_shipment_status === "shipped" && row.latest_shipment_tracking_number) {
    return {
      key: "tracking",
      label: "Marketplace tracking",
      status: "blocked",
      message: "Shipment has tracking, but no marketplace tracking push exists.",
      evidence,
      latestAt: row.latest_shipment_updated_at,
    };
  }
  return {
    key: "tracking",
    label: "Marketplace tracking",
    status: "warning",
    message: row.latest_tracking_push_id
      ? "Marketplace tracking push has not completed yet."
      : "No marketplace tracking evidence exists yet.",
    evidence,
    latestAt: row.latest_tracking_push_updated_at,
  };
}

function summarizeStageStatus(stages: readonly DropshipDogfoodSmokeStage[]): DropshipDogfoodReadinessStatus {
  if (stages.some((stage) => stage.status === "blocked")) return "blocked";
  if (stages.every((stage) => stage.status === "ready")) return "ready";
  return "warning";
}

function buildDogfoodSmokeCandidateMessage(status: DropshipDogfoodReadinessStatus): string {
  if (status === "ready") return "Listing, intake, fulfillment, and tracking evidence are all present.";
  if (status === "blocked") return "At least one dogfood smoke handoff needs ops attention.";
  return "Dogfood smoke evidence is incomplete but not blocked.";
}

function buildDogfoodSmokeMessage(input: {
  readyCandidateCount: number;
  warningCandidateCount: number;
  blockedCandidateCount: number;
}): string {
  if (input.readyCandidateCount > 0) {
    return `Loaded ${formatStoreCount(input.readyCandidateCount)} with full smoke evidence; ${input.blockedCandidateCount} blocked and ${input.warningCandidateCount} incomplete.`;
  }
  if (input.blockedCandidateCount > 0) {
    return `Loaded ${formatStoreCount(input.blockedCandidateCount)} with blocking smoke handoff evidence.`;
  }
  return `Loaded ${formatStoreCount(input.warningCandidateCount)} waiting on smoke evidence.`;
}

function formatStoreCount(count: number): string {
  return `${count} store${count === 1 ? "" : "s"}`;
}

function buildDogfoodChecks(input: {
  row: DogfoodReadinessRow;
  dropshipOmsChannelId: number | null;
  dropshipOmsChannelCount: number;
  defaultWarehouseId: number | null;
  adminCatalogIncludeRuleCount: number;
  vendorSelectionIncludeRuleCount: number;
  activeShippingBoxCount: number;
  activeShippingZoneRuleCount: number;
  activeShippingRateTableCount: number;
  activeShippingRateRowCount: number;
  selectedVariantCount: number;
  selectedPackageProfileCount: number;
  selectedVariantMissingPackageProfileCount: number;
  activeShippingMarkupPolicyCount: number;
  activeShippingInsurancePolicyCount: number;
  activeReturnPolicyCount: number;
  listingConfigActive: boolean;
  setupOpenBlockerCount: number;
  walletAvailableBalanceCents: number;
  activeFundingMethodCount: number;
  activeStripeFundingMethodCount: number;
  activeUsdcBaseFundingMethodCount: number;
  autoReloadFundingMethodReady: boolean;
  notificationPreferenceCount: number;
}): DropshipDogfoodReadinessCheck[] {
  return [
    {
      key: "dropship_oms_channel",
      label: "Dropship OMS channel",
      status: input.dropshipOmsChannelCount === 1 ? "ready" : "blocked",
      message: input.dropshipOmsChannelCount === 1 && input.dropshipOmsChannelId !== null
        ? `Dropship OMS channel ${input.dropshipOmsChannelId} is configured.`
        : input.dropshipOmsChannelCount === 0
          ? "No active Dropship OMS channel is marked in channel configuration."
          : `${input.dropshipOmsChannelCount} active Dropship OMS channels are marked; exactly one is required.`,
    },
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
      status: isDogfoodStoreConnectionReady(input.row) ? "ready" : "blocked",
      message: buildDogfoodStoreConnectionMessage(input.row),
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
      key: "shipping_boxes",
      label: "Shipping boxes",
      status: input.activeShippingBoxCount > 0 ? "ready" : "blocked",
      message: input.activeShippingBoxCount > 0
        ? `${input.activeShippingBoxCount} active shipping box(es) configured.`
        : "No active shipping boxes are configured.",
    },
    {
      key: "shipping_zones",
      label: "Shipping zones",
      status: input.defaultWarehouseId !== null && input.activeShippingZoneRuleCount > 0 ? "ready" : "blocked",
      message: input.defaultWarehouseId === null
        ? "Shipping zones cannot be evaluated until a default warehouse is configured."
        : input.activeShippingZoneRuleCount > 0
          ? `${input.activeShippingZoneRuleCount} active zone rule(s) exist for warehouse ${input.defaultWarehouseId}.`
          : `No active shipping zone rules exist for warehouse ${input.defaultWarehouseId}.`,
    },
    {
      key: "shipping_rates",
      label: "Shipping rates",
      status: input.defaultWarehouseId !== null && input.activeShippingRateTableCount > 0 && input.activeShippingRateRowCount > 0
        ? "ready"
        : "blocked",
      message: input.defaultWarehouseId === null
        ? "Shipping rates cannot be evaluated until a default warehouse is configured."
        : input.activeShippingRateTableCount > 0 && input.activeShippingRateRowCount > 0
          ? `${input.activeShippingRateRowCount} active rate row(s) across ${input.activeShippingRateTableCount} table(s).`
          : `No active shipping rate rows are available for warehouse ${input.defaultWarehouseId}.`,
    },
    {
      key: "package_profiles",
      label: "Package profiles",
      status: input.selectedVariantCount > 0 && input.selectedVariantMissingPackageProfileCount === 0 ? "ready" : "blocked",
      message: input.selectedVariantCount === 0
        ? "No active selected variants are exposed for package-profile evaluation."
        : input.selectedVariantMissingPackageProfileCount === 0
          ? `${input.selectedPackageProfileCount} selected variant package profile(s) ready.`
          : `${input.selectedVariantMissingPackageProfileCount} of ${input.selectedVariantCount} selected variant(s) are missing active package profiles.`,
    },
    {
      key: "shipping_markup_policy",
      label: "Shipping markup policy",
      status: input.activeShippingMarkupPolicyCount > 0 ? "ready" : "blocked",
      message: input.activeShippingMarkupPolicyCount > 0
        ? `${input.activeShippingMarkupPolicyCount} active shipping markup policy record(s).`
        : "No active shipping markup policy is configured; quotes cannot use implicit fee defaults.",
    },
    {
      key: "shipping_insurance_policy",
      label: "Shipping insurance policy",
      status: input.activeShippingInsurancePolicyCount > 0 ? "ready" : "blocked",
      message: input.activeShippingInsurancePolicyCount > 0
        ? `${input.activeShippingInsurancePolicyCount} active insurance policy record(s).`
        : "No active insurance policy is configured; quotes cannot use implicit insurance-pool defaults.",
    },
    {
      key: "return_policy",
      label: "Return policy",
      status: input.activeReturnPolicyCount > 0 ? "ready" : "blocked",
      message: input.activeReturnPolicyCount > 0
        ? `${input.activeReturnPolicyCount} active return policy record(s).`
        : "No active return policy is configured; RMA windows cannot use implicit defaults.",
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
      status: input.walletAvailableBalanceCents > 0 || input.activeStripeFundingMethodCount > 0 ? "ready" : "blocked",
      message: input.walletAvailableBalanceCents > 0
        ? `Wallet has ${input.walletAvailableBalanceCents} available cent(s).`
        : input.activeStripeFundingMethodCount > 0
          ? `${input.activeStripeFundingMethodCount} active Stripe funding method(s) can fund the wallet.`
          : input.activeFundingMethodCount > 0
            ? "Wallet has active funding method(s), but none are Stripe card/ACH methods ready for wallet funding."
            : "Wallet has no available balance or active funding method.",
    },
    {
      key: "usdc_base_funding",
      label: "USDC Base funding",
      status: input.activeUsdcBaseFundingMethodCount > 0 ? "ready" : "blocked",
      message: input.activeUsdcBaseFundingMethodCount > 0
        ? `${input.activeUsdcBaseFundingMethodCount} active USDC Base funding method(s) registered.`
        : "No active USDC Base funding method with a wallet address is registered.",
    },
    {
      key: "auto_reload",
      label: "Auto reload",
      status: input.row.auto_reload_enabled === true && input.autoReloadFundingMethodReady ? "ready" : "blocked",
      message: input.row.auto_reload_enabled !== true
        ? "Auto reload is disabled or not configured."
        : input.autoReloadFundingMethodReady
          ? "Auto reload is enabled with a usable Stripe card/ACH funding method."
          : input.activeStripeFundingMethodCount === 0
            ? "Auto reload is enabled, but no active Stripe card/ACH funding method with provider identity exists."
            : "Auto reload is enabled, but its selected funding method is missing, inactive, unsupported, or missing provider identity.",
    },
    {
      key: "notifications",
      label: "Notifications",
      status: "ready",
      message: `${DROPSHIP_LAUNCH_NOTIFICATION_PREFERENCES.length} launch default notification preference(s) available; ${input.notificationPreferenceCount} vendor override(s) configured.`,
    },
  ];
}

function isDogfoodStoreConnectionReady(row: DogfoodReadinessRow): boolean {
  if (row.store_connection_id === null || row.platform === null || row.store_status === null || row.setup_status === null) {
    return false;
  }

  return isDropshipStoreConnectionLaunchReady({
    platform: row.platform,
    status: row.store_status,
    setupStatus: row.setup_status,
    hasAccessToken: row.access_token_ref !== null,
    hasRefreshToken: row.refresh_token_ref !== null,
  });
}

function requiresDogfoodRefreshToken(platform: string | null): boolean {
  return platform === "ebay";
}

function buildDogfoodStoreConnectionMessage(row: DogfoodReadinessRow): string {
  if (row.store_connection_id === null) {
    return "No store connection exists.";
  }

  if (isDogfoodStoreConnectionReady(row)) {
    return requiresDogfoodRefreshToken(row.platform)
      ? "Store connection is launch-ready with access and refresh token references."
      : "Store connection is launch-ready with an access token reference.";
  }

  const status = row.store_status ?? "missing";
  return `Store is ${status}; ${describeDogfoodTokenReferences(row)}.`;
}

function describeDogfoodTokenReferences(row: DogfoodReadinessRow): string {
  const accessStatus = row.access_token_ref
    ? "access token reference present"
    : "access token reference missing";
  if (requiresDogfoodRefreshToken(row.platform)) {
    const refreshStatus = row.refresh_token_ref
      ? "eBay refresh token reference present"
      : "eBay refresh token reference missing";
    return `${accessStatus}; ${refreshStatus}`;
  }

  return accessStatus;
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

function parsePositiveIntegerOrNull(value: string | number | null): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (!value || !/^[1-9]\d*$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function maxDate(values: Array<Date | null>): Date | null {
  const dates = values.filter((value): value is Date => value instanceof Date);
  if (dates.length === 0) return null;
  return dates.reduce((latest, value) => value.getTime() > latest.getTime() ? value : latest);
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

function appendCountStatusFilter(whereSql: string, clause: string, enabled: boolean): string {
  if (!enabled) {
    return whereSql;
  }
  return whereSql ? `${whereSql} AND ${clause}` : `WHERE ${clause}`;
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
