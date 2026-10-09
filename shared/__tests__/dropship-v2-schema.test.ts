import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  DROPSHIP_DEFAULT_INSURANCE_POOL_FEE_BPS,
  DROPSHIP_DEFAULT_PAYMENT_HOLD_TIMEOUT_MINUTES,
  DROPSHIP_DEFAULT_RETURN_WINDOW_DAYS,
  DROPSHIP_DEFAULT_SHIPPING_MARKUP_BPS,
  dropshipCatalogRuleSetRevisions,
  dropshipCatalogRules,
  dropshipFaultCategoryEnum,
  dropshipOrderIntake,
  dropshipShippingMarkupConfig,
  dropshipShippingQuoteSnapshots,
  dropshipListingConfigRequests,
  dropshipListingPushJobs,
  dropshipStoreConnectionTokens,
  dropshipStoreListingConfigs,
  dropshipEbayListingPolicyOverrideRevisions,
  dropshipEbayListingPolicyOverrides,
  dropshipSourcePlatformEnum,
  dropshipStoreConnections,
  dropshipVendorSelectionRuleSetRevisions,
  dropshipVendorSelectionRules,
  dropshipVendorListings,
  dropshipWalletAccounts,
  dropshipWalletLedger,
  dropshipNotificationEvents,
  dropshipRmaInspections,
  dropshipReturnFeeSchedule,
  dropshipReturnPolicyConfig,
  dropshipRmas,
  dropshipAuditEvents,
} from "../schema/dropship.schema";

const migrationSql = readFileSync(
  resolve(process.cwd(), "migrations/0086_dropship_v2_foundation.sql"),
  "utf8",
);
const catalogExposureMigrationSql = readFileSync(
  resolve(
    process.cwd(),
    "migrations/0090_dropship_catalog_exposure_revisions.sql",
  ),
  "utf8",
);
const vendorSelectionMigrationSql = readFileSync(
  resolve(
    process.cwd(),
    "migrations/0091_dropship_vendor_selection_revisions.sql",
  ),
  "utf8",
);
const storeConnectionTokenVaultMigrationSql = readFileSync(
  resolve(
    process.cwd(),
    "migrations/0092_dropship_store_connection_token_vault.sql",
  ),
  "utf8",
);
const shippingQuoteFoundationMigrationSql = readFileSync(
  resolve(
    process.cwd(),
    "migrations/0093_dropship_shipping_quote_foundation.sql",
  ),
  "utf8",
);
const listingConnectionConfigMigrationSql = readFileSync(
  resolve(
    process.cwd(),
    "migrations/0094_dropship_listing_connection_config.sql",
  ),
  "utf8",
);
const listingConfigBackfillMigrationSql = readFileSync(
  resolve(
    process.cwd(),
    "migrations/0095_dropship_listing_config_backfill.sql",
  ),
  "utf8",
);
const returnsNotificationsMigrationSql = readFileSync(
  resolve(process.cwd(), "migrations/0097_dropship_returns_notifications.sql"),
  "utf8",
);
const opsSurfacesMigrationSql = readFileSync(
  resolve(process.cwd(), "migrations/0098_dropship_ops_surfaces.sql"),
  "utf8",
);
const fundingMethodIdentityMigrationSql = readFileSync(
  resolve(
    process.cwd(),
    "migrations/0099_dropship_funding_method_identity.sql",
  ),
  "utf8",
);
const returnPolicyConfigMigrationSql = readFileSync(
  resolve(process.cwd(), "migrations/0105_dropship_return_policy_config.sql"),
  "utf8",
);
const perFeeResponsibilityMigrationSql = readFileSync(
  resolve(
    process.cwd(),
    "migrations/0611_dropship_rma_per_fee_responsibility.sql",
  ),
  "utf8",
);
const listingConfigRevisionMigrationSql = readFileSync(
  resolve(process.cwd(), "migrations/0728_dropship_listing_config_revision.sql"),
  "utf8",
);
const releaseScript = readFileSync(
  resolve(process.cwd(), "scripts/release.sh"),
  "utf8",
);

describe("Dropship V2 schema contract", () => {
  it("uses the agreed launch defaults without floating point money", () => {
    // 24 hours since migration 0683; the launch migration text below still
    // reads 48 hours because applied migrations are immutable.
    expect(DROPSHIP_DEFAULT_PAYMENT_HOLD_TIMEOUT_MINUTES).toBe(1440);
    expect(DROPSHIP_DEFAULT_RETURN_WINDOW_DAYS).toBe(30);
    expect(DROPSHIP_DEFAULT_INSURANCE_POOL_FEE_BPS).toBe(200);
    expect(DROPSHIP_DEFAULT_SHIPPING_MARKUP_BPS).toBe(0);
    expect(migrationSql).toContain(
      "payment_hold_timeout_minutes integer NOT NULL DEFAULT 2880",
    );
    expect(migrationSql).toContain(
      "return_window_days integer NOT NULL DEFAULT 30",
    );
    expect(returnPolicyConfigMigrationSql).toContain(
      "return_window_days integer NOT NULL DEFAULT 30",
    );
    expect(migrationSql).toContain("fee_bps integer NOT NULL DEFAULT 200");
    expect(migrationSql).not.toMatch(/\b(double precision|real)\b/i);
    expect(migrationSql).toContain(
      "amount_atomic_units numeric(78,0) NOT NULL",
    );
  });

  it("models store connections instead of the discarded vendor-channel prototype", () => {
    expect(dropshipSourcePlatformEnum).toEqual([
      "ebay",
      "shopify",
      "tiktok",
      "instagram",
      "bigcommerce",
    ]);
    expect((dropshipStoreConnections as any).vendorId.name).toBe("vendor_id");
    expect((dropshipStoreConnections as any).platform.name).toBe("platform");
    expect(migrationSql).toContain(
      "CREATE TABLE IF NOT EXISTS dropship.dropship_store_connections",
    );
    expect(migrationSql).toContain("dropship_store_conn_active_vendor_idx");
    expect(migrationSql).toContain("dropship_vendors_phase0_legacy");
    expect(migrationSql).toContain("dropship_wallet_ledger_phase0_legacy");
    expect(migrationSql).toContain("dropship_vendor_products_phase0_legacy");
    expect(migrationSql).not.toContain("dropship_vendor_channels");
  });

  it("stores OAuth token material behind encrypted store connection token refs", () => {
    expect((dropshipStoreConnections as any).accessTokenRef.name).toBe(
      "access_token_ref",
    );
    expect((dropshipStoreConnections as any).refreshTokenRef.name).toBe(
      "refresh_token_ref",
    );
    expect((dropshipStoreConnectionTokens as any).tokenRef.name).toBe(
      "token_ref",
    );
    expect((dropshipStoreConnectionTokens as any).ciphertext.name).toBe(
      "ciphertext",
    );
    expect(storeConnectionTokenVaultMigrationSql).toContain(
      "dropship_store_connection_tokens",
    );
    expect(storeConnectionTokenVaultMigrationSql).toContain(
      "dropship_store_token_ref_idx",
    );
    expect(storeConnectionTokenVaultMigrationSql).toContain(
      "dropship_store_token_connection_kind_idx",
    );
  });

  it("keeps order intake idempotent by store connection and external order", () => {
    expect((dropshipOrderIntake as any).storeConnectionId.name).toBe(
      "store_connection_id",
    );
    expect((dropshipOrderIntake as any).externalOrderId.name).toBe(
      "external_order_id",
    );
    expect(migrationSql).toContain("dropship_order_intake_store_external_idx");
    expect(migrationSql).toContain(
      "ON dropship.dropship_order_intake(store_connection_id, external_order_id)",
    );
  });

  it("separates wallet account balance from idempotent ledger entries", () => {
    expect((dropshipWalletAccounts as any).availableBalanceCents.name).toBe(
      "available_balance_cents",
    );
    expect((dropshipWalletAccounts as any).pendingBalanceCents.name).toBe(
      "pending_balance_cents",
    );
    expect((dropshipWalletLedger as any).idempotencyKey.name).toBe(
      "idempotency_key",
    );
    expect(migrationSql).toContain("dropship_wallet_ref_idx");
    expect(migrationSql).toContain(
      "WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL",
    );
    expect(migrationSql).toContain("dropship_wallet_idem_idx");
    expect(fundingMethodIdentityMigrationSql).toContain(
      "dropship_funding_provider_method_idx",
    );
    expect(fundingMethodIdentityMigrationSql).toContain(
      "provider_payment_method_id IS NOT NULL",
    );
    expect(migrationSql).toContain(
      "CONSTRAINT dropship_wallet_ledger_amount_chk CHECK (amount_cents <> 0)",
    );
  });

  it("captures listing, fault, return, notification, and insurance policy constraints", () => {
    expect((dropshipVendorListings as any).productVariantId.name).toBe(
      "product_variant_id",
    );
    expect(dropshipFaultCategoryEnum).toEqual([
      "card_shellz",
      "vendor",
      "customer",
      "marketplace",
      "carrier",
    ]);
    expect(migrationSql).toContain("dropship_listing_store_variant_idx");
    expect(migrationSql).toContain("dropship_rma_fault_chk");
    expect(migrationSql).toContain("dropship_notification_pref_critical_chk");
    expect(migrationSql).toContain("dropship_insurance_bps_chk");
    expect((dropshipReturnPolicyConfig as any).returnWindowDays.name).toBe(
      "return_window_days",
    );
    expect(returnPolicyConfigMigrationSql).toContain(
      "dropship_return_policy_config",
    );
    expect(returnPolicyConfigMigrationSql).toContain(
      "dropship_return_policy_window_chk",
    );
  });

  it("keeps return inspection and notification retries idempotent", () => {
    expect((dropshipRmas as any).idempotencyKey.name).toBe("idempotency_key");
    expect((dropshipRmas as any).requestHash.name).toBe("request_hash");
    expect((dropshipRmaInspections as any).idempotencyKey.name).toBe(
      "idempotency_key",
    );
    expect((dropshipNotificationEvents as any).requestHash.name).toBe(
      "request_hash",
    );
    expect(returnsNotificationsMigrationSql).toContain("dropship_rma_idem_idx");
    expect(returnsNotificationsMigrationSql).toContain(
      "dropship_rma_inspection_one_per_rma_idx",
    );
    expect(returnsNotificationsMigrationSql).toContain(
      "dropship_notification_idem_channel_idx",
    );
  });

  it("persists per-fee defaults and immutable inspection decision evidence", () => {
    expect((dropshipReturnFeeSchedule as any).isDefault.name).toBe(
      "is_default",
    );
    expect((dropshipRmaInspections as any).feeBreakdown.name).toBe(
      "fee_breakdown",
    );
    expect(perFeeResponsibilityMigrationSql).toContain(
      "ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false",
    );
    expect(perFeeResponsibilityMigrationSql).toContain(
      "dropship_return_fee_one_active_default_scope_idx",
    );
    expect(perFeeResponsibilityMigrationSql).toContain(
      "ADD COLUMN IF NOT EXISTS fee_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb",
    );
  });

  it("indexes ops and audit surfaces for launch dashboards", () => {
    expect((dropshipAuditEvents as any).severity.name).toBe("severity");
    expect((dropshipAuditEvents as any).eventType.name).toBe("event_type");
    expect(opsSurfacesMigrationSql).toContain(
      "dropship_audit_severity_created_idx",
    );
    expect(opsSurfacesMigrationSql).toContain(
      "dropship_audit_event_type_created_idx",
    );
    expect(opsSurfacesMigrationSql).toContain(
      "dropship_listing_job_vendor_status_idx",
    );
    expect(opsSurfacesMigrationSql).toContain(
      "dropship_tracking_push_vendor_status_idx",
    );
  });

  it("keeps shipping quotes idempotent and shipping markup configurable", () => {
    expect((dropshipShippingMarkupConfig as any).markupBps.name).toBe(
      "markup_bps",
    );
    expect((dropshipShippingMarkupConfig as any).fixedMarkupCents.name).toBe(
      "fixed_markup_cents",
    );
    expect((dropshipShippingQuoteSnapshots as any).idempotencyKey.name).toBe(
      "idempotency_key",
    );
    expect((dropshipShippingQuoteSnapshots as any).requestHash.name).toBe(
      "request_hash",
    );
    expect((dropshipShippingQuoteSnapshots as any).currency.name).toBe(
      "currency",
    );
    expect(shippingQuoteFoundationMigrationSql).toContain(
      "dropship_shipping_markup_config",
    );
    expect(shippingQuoteFoundationMigrationSql).toContain(
      "dropship_shipping_quote_vendor_idem_idx",
    );
    expect(shippingQuoteFoundationMigrationSql).toContain(
      "ADD COLUMN IF NOT EXISTS request_hash",
    );
  });

  it("drives marketplace listing behavior from store connection config", () => {
    expect((dropshipStoreListingConfigs as any).storeConnectionId.name).toBe(
      "store_connection_id",
    );
    expect((dropshipStoreListingConfigs as any).listingMode.name).toBe(
      "listing_mode",
    );
    expect((dropshipStoreListingConfigs as any).inventoryMode.name).toBe(
      "inventory_mode",
    );
    expect((dropshipStoreListingConfigs as any).priceMode.name).toBe(
      "price_mode",
    );
    expect((dropshipStoreListingConfigs as any).marketplaceConfig.name).toBe(
      "marketplace_config",
    );
    // Compare-and-set version read by every listing-config writer (migration 0728).
    expect((dropshipStoreListingConfigs as any).revision.name).toBe("revision");
    expect((dropshipStoreListingConfigs as any).revision.notNull).toBe(true);
    expect((dropshipListingPushJobs as any).requestHash.name).toBe(
      "request_hash",
    );
    expect(listingConnectionConfigMigrationSql).toContain(
      "dropship_store_listing_configs",
    );
    expect(listingConnectionConfigMigrationSql).toContain(
      "listing_mode IN ('draft_first','live','manual_only')",
    );
    expect(listingConnectionConfigMigrationSql).toContain(
      "inventory_mode IN ('managed_quantity_sync','manual_quantity','disabled')",
    );
    expect(listingConnectionConfigMigrationSql).toContain(
      "ADD COLUMN IF NOT EXISTS request_hash",
    );
    expect(listingConnectionConfigMigrationSql).toContain(
      "ON dropship.dropship_listing_push_jobs(vendor_id, idempotency_key)",
    );
    expect(listingConfigBackfillMigrationSql).toContain(
      "INSERT INTO dropship.dropship_store_listing_configs",
    );
    expect(listingConfigBackfillMigrationSql).toContain(
      "ON CONFLICT (store_connection_id) DO NOTHING",
    );
  });

  describe("dropship_listing_config_requests (migration 0728)", () => {
    const LEDGER_TABLE = "dropship.dropship_listing_config_requests";
    const config = () => getTableConfig(dropshipListingConfigRequests);
    const ledgerSql = () => {
      const match = /CREATE TABLE IF NOT EXISTS dropship\.dropship_listing_config_requests \(([\s\S]*?)\n\);/
        .exec(listingConfigRevisionMigrationSql);
      if (!match) throw new Error("CREATE TABLE dropship_listing_config_requests not found in 0728");
      return match[1]!.replace(/--[^\n]*/g, "");
    };
    const foreignKeys = () => config().foreignKeys.map((foreignKey) => {
      const reference = foreignKey.reference();
      return {
        name: foreignKey.getName(),
        columns: reference.columns.map((column) => column.name),
        foreignTable: getTableConfig(reference.foreignTable).name,
        foreignColumns: reference.foreignColumns.map((column) => column.name),
      };
    });
    /** The CHECKs the migration names, with each expression in parentheses-insensitive spacing. */
    const migrationChecks = () => {
      const checks = new Map<string, string>();
      const body = ledgerSql();
      for (const match of body.matchAll(/CONSTRAINT (\w+)\s+CHECK\s*\(/g)) {
        // No CHECK in 0728 has a parenthesis inside a string literal, so depth counting is enough.
        let depth = 1;
        let index = match.index! + match[0].length;
        const start = index;
        while (depth > 0) {
          if (body[index] === "(") depth += 1;
          if (body[index] === ")") depth -= 1;
          index += 1;
        }
        checks.set(match[1]!, comparableSql(body.slice(start, index - 1)));
      }
      return checks;
    };
    const drizzleChecks = () => {
      const dialect = new PgDialect();
      return new Map(config().checks.map((check) => [
        check.name,
        comparableSql(dialect.sqlToQuery(check.value).sql.replaceAll(`"dropship"."dropship_listing_config_requests".`, "")
          .replace(/"(\w+)"/g, "$1")),
      ]));
    };

    it("is declared on the dropship schema under the migration's table name", () => {
      expect(config()).toMatchObject({ schema: "dropship", name: "dropship_listing_config_requests" });
      expect(listingConfigRevisionMigrationSql).toContain(`CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (`);
    });

    it("declares exactly the migration's columns, all NOT NULL, actor_id included", () => {
      const columns = config().columns.map((column) => column.name);
      const migrationColumns = ledgerSql()
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /^[a-z_]+ (bigint|integer|varchar\(\d+\)|timestamptz)(?=\s|,|$)/.test(line))
        .map((line) => line.split(" ")[0]!);
      expect(columns).toEqual(migrationColumns);
      expect(config().columns.filter((column) => !column.notNull).map((column) => column.name)).toEqual([]);
      expect((dropshipListingConfigRequests as any).actorId.name).toBe("actor_id");
      expect((dropshipListingConfigRequests as any).actorId.notNull).toBe(true);
      expect(ledgerSql()).toContain("actor_id varchar(255) NOT NULL,");
    });

    it("ties the store to its vendor with the composite owner FK and has no single-column store FK", () => {
      expect(foreignKeys()).toContainEqual({
        name: "dropship_listing_config_requests_owner_fk",
        columns: ["store_connection_id", "vendor_id"],
        foreignTable: "dropship_store_connections",
        foreignColumns: ["id", "vendor_id"],
      });
      expect(ledgerSql()).toContain(
        "CONSTRAINT dropship_listing_config_requests_owner_fk FOREIGN KEY (store_connection_id, vendor_id)\n"
        + "    REFERENCES dropship.dropship_store_connections(id, vendor_id)",
      );
      // The vendor is referenced on its own as well, as the migration's inline
      // REFERENCES does (unnamed there, so compared by columns, not by name).
      expect(foreignKeys().filter((foreignKey) => foreignKey.name !== "dropship_listing_config_requests_owner_fk")
        .map(({ columns, foreignTable, foreignColumns }) => ({ columns, foreignTable, foreignColumns })))
        .toEqual([{ columns: ["vendor_id"], foreignTable: "dropship_vendors", foreignColumns: ["id"] }]);
      expect(ledgerSql()).toContain("vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id),");
      expect(foreignKeys().filter((foreignKey) => foreignKey.foreignTable === "dropship_store_connections"))
        .toHaveLength(1);
      expect(ledgerSql()).toContain("store_connection_id integer NOT NULL,");
    });

    it("keeps one request per vendor key in a unique (vendor_id, idempotency_key) index, and a store history index", () => {
      expect(config().indexes.map((index) => ({
        name: index.config.name,
        unique: index.config.unique,
        columns: index.config.columns.map((column) => (column as { name: string }).name),
      }))).toEqual([
        { name: "dropship_listing_config_requests_key_idx", unique: true, columns: ["vendor_id", "idempotency_key"] },
        { name: "dropship_listing_config_requests_store_idx", unique: false, columns: ["store_connection_id", "created_at"] },
      ]);
      expect(listingConfigRevisionMigrationSql).toContain(
        `CREATE UNIQUE INDEX IF NOT EXISTS dropship_listing_config_requests_key_idx\n  ON ${LEDGER_TABLE}(vendor_id, idempotency_key);`,
      );
      expect(listingConfigRevisionMigrationSql).toContain(
        `CREATE INDEX IF NOT EXISTS dropship_listing_config_requests_store_idx\n  ON ${LEDGER_TABLE}(store_connection_id, created_at);`,
      );
    });

    it("declares every CHECK the migration names, with the same expression", () => {
      expect([...drizzleChecks().keys()].sort()).toEqual([
        "dropship_listing_config_requests_actor_chk",
        "dropship_listing_config_requests_actor_id_chk",
        "dropship_listing_config_requests_hash_chk",
        "dropship_listing_config_requests_key_chk",
        "dropship_listing_config_requests_operation_chk",
        "dropship_listing_config_requests_outcome_chk",
      ]);
      expect(drizzleChecks()).toEqual(migrationChecks());
      expect(drizzleChecks().get("dropship_listing_config_requests_actor_id_chk"))
        .toBe(comparableSql("btrim(actor_id) <> ''"));
    });

    it("names in Drizzle every constraint and index the migration names for the ledger", () => {
      const migrationNames = [
        ...[...ledgerSql().matchAll(/CONSTRAINT (\w+)/g)].map((match) => match[1]!),
        ...[...listingConfigRevisionMigrationSql.matchAll(
          /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)\s+ON dropship\.dropship_listing_config_requests\(/g,
        )].map((match) => match[1]!),
      ].sort();
      const drizzleNames = [
        ...config().checks.map((check) => check.name),
        ...foreignKeys().map((foreignKey) => foreignKey.name),
        ...config().indexes.map((index) => index.config.name!),
      ];
      expect(migrationNames).toHaveLength(9);
      expect(drizzleNames).toEqual(expect.arrayContaining(migrationNames));
    });
  });

  it("models revisioned eBay listing policy overrides at store-variant scope", () => {
    expect((dropshipEbayListingPolicyOverrideRevisions as any).idempotencyKey.name).toBe(
      "idempotency_key",
    );
    expect((dropshipEbayListingPolicyOverrideRevisions as any).requestHash.name).toBe(
      "request_hash",
    );
    expect((dropshipEbayListingPolicyOverrides as any).storeConnectionId.name).toBe(
      "store_connection_id",
    );
    expect((dropshipEbayListingPolicyOverrides as any).productVariantId.name).toBe(
      "product_variant_id",
    );
    expect((dropshipEbayListingPolicyOverrides as any).fulfillmentPolicyId.name).toBe(
      "fulfillment_policy_id",
    );
  });

  it("tracks admin dropship catalog exposure revisions idempotently", () => {
    expect((dropshipCatalogRuleSetRevisions as any).idempotencyKey.name).toBe(
      "idempotency_key",
    );
    expect((dropshipCatalogRuleSetRevisions as any).requestHash.name).toBe(
      "request_hash",
    );
    expect((dropshipCatalogRules as any).revisionId.name).toBe("revision_id");
    expect(catalogExposureMigrationSql).toContain(
      "dropship_catalog_rule_set_revisions",
    );
    expect(catalogExposureMigrationSql).toContain(
      "dropship_catalog_rule_rev_idem_idx",
    );
    expect(catalogExposureMigrationSql).toContain(
      "ADD COLUMN IF NOT EXISTS revision_id",
    );
  });

  it("tracks vendor selection rule revisions idempotently per vendor", () => {
    expect((dropshipVendorSelectionRuleSetRevisions as any).vendorId.name).toBe(
      "vendor_id",
    );
    expect(
      (dropshipVendorSelectionRuleSetRevisions as any).idempotencyKey.name,
    ).toBe("idempotency_key");
    expect(
      (dropshipVendorSelectionRuleSetRevisions as any).requestHash.name,
    ).toBe("request_hash");
    expect((dropshipVendorSelectionRules as any).revisionId.name).toBe(
      "revision_id",
    );
    expect(vendorSelectionMigrationSql).toContain(
      "dropship_vendor_selection_rule_set_revisions",
    );
    expect(vendorSelectionMigrationSql).toContain(
      "dropship_selection_rule_rev_vendor_idem_idx",
    );
    expect(vendorSelectionMigrationSql).toContain(
      "ADD COLUMN IF NOT EXISTS revision_id",
    );
  });

  it("does not swallow SQL migration failures during release", () => {
    expect(releaseScript).toContain("npx tsx migrations/run-migrations.ts");
    expect(releaseScript).not.toContain(
      "SQL migration step completed with warnings",
    );
    expect(releaseScript).not.toContain(
      "drizzle-kit push exited with non-zero",
    );
    expect(releaseScript).toContain("RUN_DRIZZLE_PUSH_ON_RELEASE");
  });
});

/** SQL with its spacing normalized, and no space beside a parenthesis, so two layouts of one expression compare equal. */
function comparableSql(sql: string): string {
  return sql.replace(/\s+/g, " ").replace(/\s*([()])\s*/g, "$1").trim();
}

describe("Dropship V2 prototype retirement contract", () => {
  it("does not keep Phase 0 startup DDL or route registration live", () => {
    const dbBootstrap = readFileSync(
      resolve(process.cwd(), "server/db.ts"),
      "utf8",
    );
    const routeRegistry = readFileSync(
      resolve(process.cwd(), "server/routes.ts"),
      "utf8",
    );
    const appStartup = readFileSync(
      resolve(process.cwd(), "server/index.ts"),
      "utf8",
    );

    expect(dbBootstrap).not.toContain(
      "CREATE TABLE IF NOT EXISTS dropship_vendors",
    );
    expect(dbBootstrap).not.toContain(
      "CREATE TABLE IF NOT EXISTS dropship_vendor_products",
    );
    expect(routeRegistry).not.toContain("registerVendorPortalRoutes(app)");
    expect(routeRegistry).not.toContain("registerVendorEbayRoutes(app)");
    expect(appStartup).not.toContain("startVendorOrderPolling()");
  });

  it("removes Phase 0 implementation files from active source", () => {
    const retiredFiles = [
      "server/modules/dropship/admin.routes.ts",
      "server/modules/dropship/vendor-auth.routes.ts",
      "server/modules/dropship/vendor-auth.ts",
      "server/modules/dropship/vendor-catalog.routes.ts",
      "server/modules/dropship/vendor-ebay.routes.ts",
      "server/modules/dropship/vendor-order-polling.ts",
      "server/modules/dropship/vendor-orders.routes.ts",
      "server/modules/dropship/vendor-portal.routes.ts",
      "server/modules/dropship/vendor-wallet.routes.ts",
      "server/modules/dropship/vendor-webhooks.ts",
      "server/modules/dropship/wallet.service.ts",
      "server/modules/dropship/application/catalogOrchestrator.ts",
      "server/modules/dropship/application/onboardingOrchestrator.ts",
      "server/modules/dropship/application/orderOrchestrator.ts",
      "server/modules/dropship/application/walletOrchestrator.ts",
      "server/modules/dropship/interfaces/http/agent.controller.ts",
      "server/modules/dropship/interfaces/http/catalog.controller.ts",
      "server/modules/dropship/interfaces/http/vendor.controller.ts",
      "server/modules/dropship/interfaces/http/wallet.controller.ts",
      "server/modules/dropship/infrastructure/ebay.client.ts",
      "server/modules/dropship/infrastructure/stripe.client.ts",
    ];

    for (const file of retiredFiles) {
      expect(existsSync(resolve(process.cwd(), file)), file).toBe(false);
    }
  });
});
