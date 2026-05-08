import { z } from "zod";
import { DropshipError } from "../domain/errors";
import { DROPSHIP_LAUNCH_NOTIFICATION_PREFERENCES } from "./dropship-notification-service";
import type { DropshipClock, DropshipLogEvent, DropshipLogger } from "./dropship-ports";
import type { DropshipVendorProvisioningService } from "./dropship-vendor-provisioning-service";

const positiveIdSchema = z.number().int().positive();
const pageSchema = z.number().int().positive().default(1);
const limitSchema = z.number().int().positive().max(100).default(50);
const optionalStringSchema = z.string().trim().min(1).max(255).optional();
const severitySchema = z.enum(["info", "warning", "error"]);

const searchAuditEventsInputSchema = z.object({
  vendorId: positiveIdSchema.optional(),
  storeConnectionId: positiveIdSchema.optional(),
  entityType: optionalStringSchema,
  entityId: optionalStringSchema,
  eventType: optionalStringSchema,
  severity: severitySchema.optional(),
  search: optionalStringSchema,
  createdFrom: z.date().optional(),
  createdTo: z.date().optional(),
  page: pageSchema,
  limit: limitSchema,
}).strict();

const adminOpsOverviewInputSchema = z.object({
  vendorId: positiveIdSchema.optional(),
  storeConnectionId: positiveIdSchema.optional(),
}).strict();

const dogfoodReadinessStatusSchema = z.enum(["ready", "warning", "blocked"]);
const dogfoodReadinessInputSchema = z.object({
  status: dogfoodReadinessStatusSchema.optional(),
  platform: z.enum(["ebay", "shopify"]).optional(),
  search: optionalStringSchema,
  page: pageSchema,
  limit: limitSchema,
}).strict();

export type SearchDropshipAuditEventsInput = z.infer<typeof searchAuditEventsInputSchema>;
export type GetDropshipAdminOpsOverviewInput = z.infer<typeof adminOpsOverviewInputSchema>;
export type DropshipDogfoodReadinessStatus = z.infer<typeof dogfoodReadinessStatusSchema>;
export type ListDropshipDogfoodReadinessInput = z.infer<typeof dogfoodReadinessInputSchema>;

export interface DropshipOpsSettingsSection {
  key: "account" | "store_connection" | "wallet_payment" | "notifications" | "api_keys" | "webhooks" | "return_contact";
  label: string;
  status: "ready" | "attention_required" | "coming_soon";
  comingSoon: boolean;
  summary: string;
  blockers: string[];
}

export interface DropshipVendorSettingsOverview {
  vendor: {
    vendorId: number;
    memberId: string;
    businessName: string | null;
    email: string | null;
    status: string;
    entitlementStatus: string;
    includedStoreConnections: number;
  };
  account: {
    hasContactEmail: boolean;
    hasBusinessName: boolean;
  };
  storeConnections: Array<{
    storeConnectionId: number;
    platform: string;
    status: string;
    setupStatus: string;
    externalDisplayName: string | null;
    shopDomain: string | null;
    hasAccessToken: boolean;
    hasRefreshToken: boolean;
    launchReady: boolean;
    updatedAt: Date;
  }>;
  wallet: {
    availableBalanceCents: number;
    pendingBalanceCents: number;
    autoReloadEnabled: boolean;
    fundingMethodCount: number;
    activeStripeFundingMethodCount: number;
    activeUsdcBaseFundingMethodCount: number;
    autoReloadFundingMethodReady: boolean;
  };
  notificationPreferences: {
    configuredCount: number;
  };
  sections: DropshipOpsSettingsSection[];
  generatedAt: Date;
}

export interface DropshipOpsCount {
  key: string;
  count: number;
}

export interface DropshipOpsRiskBucket {
  key: string;
  label: string;
  severity: "info" | "warning" | "error";
  count: number;
}

export interface DropshipAuditEventRecord {
  auditEventId: number;
  vendorId: number | null;
  vendorBusinessName: string | null;
  vendorEmail: string | null;
  storeConnectionId: number | null;
  storePlatform: string | null;
  storeDisplayName: string | null;
  entityType: string;
  entityId: string | null;
  eventType: string;
  actorType: string;
  actorId: string | null;
  severity: "info" | "warning" | "error";
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface DropshipAuditEventSearchResult {
  items: DropshipAuditEventRecord[];
  total: number;
  page: number;
  limit: number;
}

export interface DropshipAdminOpsOverview {
  generatedAt: Date;
  riskBuckets: DropshipOpsRiskBucket[];
  vendorStatusCounts: DropshipOpsCount[];
  storeConnectionStatusCounts: DropshipOpsCount[];
  orderIntakeStatusCounts: DropshipOpsCount[];
  orderCancellationStatusCounts: DropshipOpsCount[];
  listingPushJobStatusCounts: DropshipOpsCount[];
  trackingPushStatusCounts: DropshipOpsCount[];
  rmaStatusCounts: DropshipOpsCount[];
  notificationStatusCounts: DropshipOpsCount[];
  recentAuditEvents: DropshipAuditEventRecord[];
}

export interface DropshipDogfoodReadinessCheck {
  key: string;
  label: string;
  status: "ready" | "warning" | "blocked";
  message: string;
}

export interface DropshipSystemReadinessCheck {
  key: string;
  label: string;
  status: "ready" | "warning" | "blocked";
  message: string;
  requiredEnv: string[];
}

export interface DropshipDogfoodReadinessItem {
  vendor: {
    vendorId: number;
    memberId: string;
    businessName: string | null;
    email: string | null;
    status: string;
    entitlementStatus: string;
  };
  storeConnection: {
    storeConnectionId: number | null;
    platform: string | null;
    status: string | null;
    setupStatus: string | null;
    externalDisplayName: string | null;
    shopDomain: string | null;
    updatedAt: Date | null;
  };
  readinessStatus: DropshipDogfoodReadinessStatus;
  blockerCount: number;
  warningCount: number;
  checks: DropshipDogfoodReadinessCheck[];
  metrics: {
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
    listingConfigActive: boolean;
    setupOpenBlockerCount: number;
    walletAvailableBalanceCents: number;
    activeFundingMethodCount: number;
    activeStripeFundingMethodCount: number;
    activeUsdcBaseFundingMethodCount: number;
    autoReloadEnabled: boolean;
    autoReloadFundingMethodReady: boolean;
    notificationPreferenceCount: number;
  };
}

export interface DropshipDogfoodReadinessSummary {
  status: DropshipDogfoodReadinessStatus;
  count: number;
}

export interface DropshipDogfoodLaunchGateBlocker {
  scope: "system" | "vendor_store";
  key: string;
  label: string;
  message: string;
  vendorId?: number;
  storeConnectionId?: number | null;
}

export interface DropshipDogfoodLaunchGate {
  status: DropshipDogfoodReadinessStatus;
  readyVendorStoreCount: number;
  warningVendorStoreCount: number;
  blockedVendorStoreCount: number;
  systemBlockedCount: number;
  systemWarningCount: number;
  blockerCount: number;
  warningCount: number;
  message: string;
  firstBlockers: DropshipDogfoodLaunchGateBlocker[];
}

export interface DropshipDogfoodReadinessResult {
  generatedAt: Date;
  items: DropshipDogfoodReadinessItem[];
  launchGateItems?: DropshipDogfoodReadinessItem[];
  total: number;
  page: number;
  limit: number;
  summary: DropshipDogfoodReadinessSummary[];
  systemChecks: DropshipSystemReadinessCheck[];
  launchGate?: DropshipDogfoodLaunchGate;
}

export interface DropshipOpsSurfaceRepository {
  getVendorSettingsOverview(vendorId: number, generatedAt: Date): Promise<DropshipVendorSettingsOverview>;
  getAdminOpsOverview(
    input: GetDropshipAdminOpsOverviewInput & { generatedAt: Date },
  ): Promise<DropshipAdminOpsOverview>;
  searchAuditEvents(input: SearchDropshipAuditEventsInput): Promise<DropshipAuditEventSearchResult>;
  listDogfoodReadiness(
    input: ListDropshipDogfoodReadinessInput & { generatedAt: Date },
  ): Promise<DropshipDogfoodReadinessResult>;
}

export class DropshipOpsSurfaceService {
  constructor(
    private readonly deps: {
      vendorProvisioning: DropshipVendorProvisioningService;
      repository: DropshipOpsSurfaceRepository;
      clock: DropshipClock;
      logger: DropshipLogger;
    },
  ) {}

  async getVendorSettingsForMember(memberId: string): Promise<DropshipVendorSettingsOverview> {
    const vendor = await this.deps.vendorProvisioning.provisionForMember(memberId);
    return this.deps.repository.getVendorSettingsOverview(vendor.vendor.vendorId, this.deps.clock.now());
  }

  async getAdminOpsOverview(input: unknown = {}): Promise<DropshipAdminOpsOverview> {
    const parsed = parseOpsSurfaceInput(
      adminOpsOverviewInputSchema,
      input,
      "DROPSHIP_OPS_OVERVIEW_INVALID_INPUT",
    );
    const overview = await this.deps.repository.getAdminOpsOverview({
      ...parsed,
      generatedAt: this.deps.clock.now(),
    });
    this.deps.logger.info({
      code: "DROPSHIP_OPS_OVERVIEW_VIEWED",
      message: "Dropship admin ops overview was loaded.",
      context: {
        vendorId: parsed.vendorId ?? null,
        storeConnectionId: parsed.storeConnectionId ?? null,
        riskBucketCount: overview.riskBuckets.length,
      },
    });
    return overview;
  }

  async searchAuditEvents(input: unknown = {}): Promise<DropshipAuditEventSearchResult> {
    const parsed = parseOpsSurfaceInput(
      searchAuditEventsInputSchema,
      input,
      "DROPSHIP_AUDIT_SEARCH_INVALID_INPUT",
    );
    return this.deps.repository.searchAuditEvents(parsed);
  }

  async listDogfoodReadiness(input: unknown = {}): Promise<DropshipDogfoodReadinessResult> {
    const parsed = parseOpsSurfaceInput(
      dogfoodReadinessInputSchema,
      input,
      "DROPSHIP_DOGFOOD_READINESS_INVALID_INPUT",
    );
    const result = await this.deps.repository.listDogfoodReadiness({
      ...parsed,
      generatedAt: this.deps.clock.now(),
    });
    const { launchGateItems, ...publicResult } = result;
    const systemChecks = buildDropshipSystemReadinessChecks(process.env);
    this.deps.logger.info({
      code: "DROPSHIP_DOGFOOD_READINESS_VIEWED",
      message: "Dropship dogfood readiness was loaded.",
      context: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        status: parsed.status ?? null,
        platform: parsed.platform ?? null,
      },
    });
    return {
      ...publicResult,
      systemChecks,
      launchGate: buildDropshipDogfoodLaunchGate({
        summary: publicResult.summary,
        items: launchGateItems ?? publicResult.items,
        systemChecks,
      }),
    };
  }
}

export function buildDropshipDogfoodLaunchGate(input: {
  summary: readonly DropshipDogfoodReadinessSummary[];
  items: readonly DropshipDogfoodReadinessItem[];
  systemChecks: readonly DropshipSystemReadinessCheck[];
}): DropshipDogfoodLaunchGate {
  const readyVendorStoreCount = readinessSummaryCount(input.summary, "ready");
  const warningVendorStoreCount = readinessSummaryCount(input.summary, "warning");
  const blockedVendorStoreCount = readinessSummaryCount(input.summary, "blocked");
  const systemBlocked = input.systemChecks.filter((check) => check.status === "blocked");
  const systemWarnings = input.systemChecks.filter((check) => check.status === "warning");
  const vendorBlockers = input.items.flatMap((item) =>
    item.checks
      .filter((check) => check.status === "blocked")
      .map((check) => ({
        scope: "vendor_store" as const,
        key: check.key,
        label: check.label,
        message: check.message,
        vendorId: item.vendor.vendorId,
        storeConnectionId: item.storeConnection.storeConnectionId,
      })),
  );
  const vendorWarnings = input.items.flatMap((item) =>
    item.checks
      .filter((check) => check.status === "warning")
      .map((check) => ({
        scope: "vendor_store" as const,
        key: check.key,
        label: check.label,
        message: check.message,
        vendorId: item.vendor.vendorId,
        storeConnectionId: item.storeConnection.storeConnectionId,
      })),
  );
  const firstBlockers: DropshipDogfoodLaunchGateBlocker[] = [
    ...systemBlocked.map((check) => ({
      scope: "system" as const,
      key: check.key,
      label: check.label,
      message: check.message,
    })),
    ...vendorBlockers,
  ].slice(0, 10);

  const blockerCount = systemBlocked.length + vendorBlockers.length;
  const warningCount = systemWarnings.length + vendorWarnings.length;
  const status: DropshipDogfoodReadinessStatus = systemBlocked.length > 0 || readyVendorStoreCount === 0
    ? "blocked"
    : warningCount > 0 || blockedVendorStoreCount > 0
      ? "warning"
      : "ready";

  return {
    status,
    readyVendorStoreCount,
    warningVendorStoreCount,
    blockedVendorStoreCount,
    systemBlockedCount: systemBlocked.length,
    systemWarningCount: systemWarnings.length,
    blockerCount,
    warningCount,
    message: buildDogfoodLaunchGateMessage({
      status,
      readyVendorStoreCount,
      systemBlockedCount: systemBlocked.length,
      blockedVendorStoreCount,
      warningCount,
    }),
    firstBlockers,
  };
}

function buildDogfoodLaunchGateMessage(input: {
  status: DropshipDogfoodReadinessStatus;
  readyVendorStoreCount: number;
  systemBlockedCount: number;
  blockedVendorStoreCount: number;
  warningCount: number;
}): string {
  if (input.systemBlockedCount > 0) {
    return `${input.systemBlockedCount} system prerequisite(s) block dogfood.`;
  }
  if (input.readyVendorStoreCount === 0) {
    return "No vendor/store row is ready for dogfood.";
  }
  if (input.status === "warning") {
    return `${input.readyVendorStoreCount} vendor/store row(s) ready; ${input.blockedVendorStoreCount} blocked row(s) and ${input.warningCount} warning(s) remain.`;
  }
  return `${input.readyVendorStoreCount} vendor/store row(s) ready for dogfood.`;
}

function readinessSummaryCount(
  summary: readonly DropshipDogfoodReadinessSummary[],
  status: DropshipDogfoodReadinessStatus,
): number {
  return summary.find((item) => item.status === status)?.count ?? 0;
}

export function buildDropshipSystemReadinessChecks(
  env: NodeJS.ProcessEnv,
): DropshipSystemReadinessCheck[] {
  return [
    buildSchedulerCheck(env),
    buildListingPushWorkerCheck(env),
    buildOrderProcessingWorkerCheck(env),
    buildEbayOrderIntakeWorkerCheck(env),
    buildTokenVaultCheck(env),
    buildOAuthStateCheck(env),
    buildEbayOAuthCheck(env),
    buildShopifyOAuthCheck(env),
    buildShopifyWebhookSubscriptionCheck(env),
    buildEmailNotificationCheck(env),
    buildShipStationCredentialsCheck(env),
    buildShipStationWebhookSecurityCheck(env),
    buildSplitShipmentHandoffCheck(env),
    buildStripeFundingCheck(env),
    buildUsdcBaseFundingCheck(),
  ];
}

function buildSchedulerCheck(env: NodeJS.ProcessEnv): DropshipSystemReadinessCheck {
  if (env.DISABLE_SCHEDULERS === "true") {
    return {
      key: "scheduler_runtime",
      label: "Scheduler runtime",
      status: "blocked",
      message: "DISABLE_SCHEDULERS=true disables dropship background workers.",
      requiredEnv: ["DISABLE_SCHEDULERS must not be true"],
    };
  }

  return {
    key: "scheduler_runtime",
    label: "Scheduler runtime",
    status: "ready",
    message: "Background scheduler runtime is allowed to start dropship workers.",
    requiredEnv: ["DISABLE_SCHEDULERS must not be true"],
  };
}

function buildListingPushWorkerCheck(env: NodeJS.ProcessEnv): DropshipSystemReadinessCheck {
  if (env.DISABLE_SCHEDULERS === "true" || env.DROPSHIP_LISTING_PUSH_WORKER_DISABLED === "true") {
    return {
      key: "listing_push_worker",
      label: "Listing push worker",
      status: "blocked",
      message: "Dropship listing pushes will remain queued while the listing push worker is disabled.",
      requiredEnv: ["DROPSHIP_LISTING_PUSH_WORKER_DISABLED must not be true"],
    };
  }

  return {
    key: "listing_push_worker",
    label: "Listing push worker",
    status: "ready",
    message: "Dropship listing push worker is enabled by default.",
    requiredEnv: ["DROPSHIP_LISTING_PUSH_WORKER_DISABLED must not be true"],
  };
}

function buildOrderProcessingWorkerCheck(env: NodeJS.ProcessEnv): DropshipSystemReadinessCheck {
  if (env.DISABLE_SCHEDULERS === "true" || env.DROPSHIP_ORDER_PROCESSING_WORKER_DISABLED === "true") {
    return {
      key: "order_processing_worker",
      label: "Order processing worker",
      status: "blocked",
      message: "Dropship order intake will not automatically quote, debit, reserve, or create OMS orders while the order processor is disabled.",
      requiredEnv: ["DROPSHIP_ORDER_PROCESSING_WORKER_ENABLED=true"],
    };
  }
  if (env.DROPSHIP_ORDER_PROCESSING_WORKER_ENABLED !== "true") {
    return {
      key: "order_processing_worker",
      label: "Order processing worker",
      status: "blocked",
      message: "DROPSHIP_ORDER_PROCESSING_WORKER_ENABLED=true is required before dropship order intake is processed automatically.",
      requiredEnv: ["DROPSHIP_ORDER_PROCESSING_WORKER_ENABLED=true"],
    };
  }

  return {
    key: "order_processing_worker",
    label: "Order processing worker",
    status: "ready",
    message: "Dropship order processing worker is enabled.",
    requiredEnv: ["DROPSHIP_ORDER_PROCESSING_WORKER_ENABLED=true"],
  };
}

function buildEbayOrderIntakeWorkerCheck(env: NodeJS.ProcessEnv): DropshipSystemReadinessCheck {
  if (env.DISABLE_SCHEDULERS === "true" || env.DROPSHIP_EBAY_ORDER_INTAKE_WORKER_DISABLED === "true") {
    return {
      key: "ebay_order_intake_worker",
      label: "eBay order intake worker",
      status: "blocked",
      message: "Dropship eBay connected stores will not be polled for new paid orders while the eBay intake worker is disabled.",
      requiredEnv: ["DROPSHIP_EBAY_ORDER_INTAKE_WORKER_DISABLED must not be true"],
    };
  }

  return {
    key: "ebay_order_intake_worker",
    label: "eBay order intake worker",
    status: "ready",
    message: "Dropship eBay order intake worker is enabled by default.",
    requiredEnv: ["DROPSHIP_EBAY_ORDER_INTAKE_WORKER_DISABLED must not be true"],
  };
}

function buildTokenVaultCheck(env: NodeJS.ProcessEnv): DropshipSystemReadinessCheck {
  const key = env.DROPSHIP_TOKEN_ENCRYPTION_KEY?.trim();
  if (!key) {
    return {
      key: "token_vault",
      label: "Token vault",
      status: "blocked",
      message: "DROPSHIP_TOKEN_ENCRYPTION_KEY is required before vendor store OAuth can persist tokens.",
      requiredEnv: ["DROPSHIP_TOKEN_ENCRYPTION_KEY"],
    };
  }

  if (!isValidTokenEncryptionKey(key)) {
    return {
      key: "token_vault",
      label: "Token vault",
      status: "blocked",
      message: "DROPSHIP_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes as base64 or hex.",
      requiredEnv: ["DROPSHIP_TOKEN_ENCRYPTION_KEY"],
    };
  }

  return {
    key: "token_vault",
    label: "Token vault",
    status: "ready",
    message: `Store token encryption is configured with key id ${env.DROPSHIP_TOKEN_KEY_ID || "dropship-token-key-v1"}.`,
    requiredEnv: ["DROPSHIP_TOKEN_ENCRYPTION_KEY"],
  };
}

function buildOAuthStateCheck(env: NodeJS.ProcessEnv): DropshipSystemReadinessCheck {
  const configured = firstConfiguredEnv(env, [
    "DROPSHIP_STORE_OAUTH_STATE_SECRET",
    "DROPSHIP_AUTH_CHALLENGE_SECRET",
    "SESSION_SECRET",
  ]);
  if (!configured) {
    return {
      key: "oauth_state_signing",
      label: "OAuth state signing",
      status: "blocked",
      message: "Store OAuth state signing requires a secret of at least 32 characters.",
      requiredEnv: ["DROPSHIP_STORE_OAUTH_STATE_SECRET", "DROPSHIP_AUTH_CHALLENGE_SECRET", "SESSION_SECRET"],
    };
  }

  if ((env[configured]?.trim().length ?? 0) < 32) {
    return {
      key: "oauth_state_signing",
      label: "OAuth state signing",
      status: "blocked",
      message: `${configured} is configured but shorter than the 32 character minimum.`,
      requiredEnv: ["DROPSHIP_STORE_OAUTH_STATE_SECRET", "DROPSHIP_AUTH_CHALLENGE_SECRET", "SESSION_SECRET"],
    };
  }

  return {
    key: "oauth_state_signing",
    label: "OAuth state signing",
    status: "ready",
    message: `Store OAuth state signing is configured through ${configured}.`,
    requiredEnv: ["DROPSHIP_STORE_OAUTH_STATE_SECRET", "DROPSHIP_AUTH_CHALLENGE_SECRET", "SESSION_SECRET"],
  };
}

function buildEbayOAuthCheck(env: NodeJS.ProcessEnv): DropshipSystemReadinessCheck {
  const missing = missingEnv(env, ["EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET"]);
  const hasRuName = hasEnv(env, "EBAY_VENDOR_RUNAME") || hasEnv(env, "EBAY_RUNAME");
  if (!hasRuName) {
    missing.push("EBAY_VENDOR_RUNAME or EBAY_RUNAME");
  }
  if (missing.length > 0) {
    return {
      key: "ebay_oauth",
      label: "eBay OAuth",
      status: "blocked",
      message: `eBay vendor store OAuth is missing ${missing.join(", ")}.`,
      requiredEnv: ["EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_VENDOR_RUNAME or EBAY_RUNAME"],
    };
  }

  return {
    key: "ebay_oauth",
    label: "eBay OAuth",
    status: "ready",
    message: `eBay vendor OAuth is configured for ${env.EBAY_ENVIRONMENT === "sandbox" ? "sandbox" : "production"}.`,
    requiredEnv: ["EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_VENDOR_RUNAME or EBAY_RUNAME"],
  };
}

function buildShopifyOAuthCheck(env: NodeJS.ProcessEnv): DropshipSystemReadinessCheck {
  const missing = missingEnv(env, ["SHOPIFY_API_KEY", "SHOPIFY_API_SECRET"]);
  const hasRedirectUri = hasEnv(env, "DROPSHIP_SHOPIFY_OAUTH_REDIRECT_URI") || hasEnv(env, "SHOPIFY_OAUTH_REDIRECT_URI");
  if (!hasRedirectUri) {
    missing.push("DROPSHIP_SHOPIFY_OAUTH_REDIRECT_URI or SHOPIFY_OAUTH_REDIRECT_URI");
  }
  if (missing.length > 0) {
    return {
      key: "shopify_oauth",
      label: "Shopify OAuth",
      status: "blocked",
      message: `Shopify vendor store OAuth is missing ${missing.join(", ")}.`,
      requiredEnv: ["SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "DROPSHIP_SHOPIFY_OAUTH_REDIRECT_URI or SHOPIFY_OAUTH_REDIRECT_URI"],
    };
  }

  return {
    key: "shopify_oauth",
    label: "Shopify OAuth",
    status: "ready",
    message: "Shopify vendor OAuth is configured.",
    requiredEnv: ["SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "DROPSHIP_SHOPIFY_OAUTH_REDIRECT_URI or SHOPIFY_OAUTH_REDIRECT_URI"],
  };
}

function buildShopifyWebhookSubscriptionCheck(env: NodeJS.ProcessEnv): DropshipSystemReadinessCheck {
  const configured = firstConfiguredEnv(env, [
    "DROPSHIP_SHOPIFY_WEBHOOK_BASE_URL",
    "DROPSHIP_PUBLIC_BASE_URL",
    "DROPSHIP_API_BASE_URL",
    "APP_BASE_URL",
    "PUBLIC_APP_URL",
  ]);
  const requiredEnv = [
    "DROPSHIP_SHOPIFY_WEBHOOK_BASE_URL or DROPSHIP_PUBLIC_BASE_URL or DROPSHIP_API_BASE_URL or APP_BASE_URL or PUBLIC_APP_URL",
  ];
  if (!configured) {
    return {
      key: "shopify_webhook_subscriptions",
      label: "Shopify webhook subscriptions",
      status: "blocked",
      message: "Shopify order intake webhook subscriptions require a public HTTPS API base URL.",
      requiredEnv,
    };
  }

  const value = env[configured]?.trim() ?? "";
  if (!isValidHttpsUrl(value)) {
    return {
      key: "shopify_webhook_subscriptions",
      label: "Shopify webhook subscriptions",
      status: "blocked",
      message: `${configured} must be a valid HTTPS URL.`,
      requiredEnv,
    };
  }

  return {
    key: "shopify_webhook_subscriptions",
    label: "Shopify webhook subscriptions",
    status: "ready",
    message: `Shopify order intake webhooks will be registered against ${configured}.`,
    requiredEnv,
  };
}

function buildEmailNotificationCheck(env: NodeJS.ProcessEnv): DropshipSystemReadinessCheck {
  const requiredEnv = ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"];
  const missing = missingEnv(env, requiredEnv);
  if (missing.length > 0) {
    return {
      key: "email_notifications",
      label: "Email notifications",
      status: "blocked",
      message: `Dropship email notifications are missing ${missing.join(", ")}.`,
      requiredEnv,
    };
  }

  if (!hasEnv(env, "SMTP_FROM")) {
    return {
      key: "email_notifications",
      label: "Email notifications",
      status: "warning",
      message: "SMTP_FROM is not configured; dropship email notifications will use SMTP_USER as the sender.",
      requiredEnv: [...requiredEnv, "SMTP_FROM recommended"],
    };
  }

  return {
    key: "email_notifications",
    label: "Email notifications",
    status: "ready",
    message: "SMTP email notifications are configured for dropship notifications.",
    requiredEnv: [...requiredEnv, "SMTP_FROM"],
  };
}

function buildShipStationCredentialsCheck(env: NodeJS.ProcessEnv): DropshipSystemReadinessCheck {
  const missing = missingEnv(env, ["SHIPSTATION_API_KEY", "SHIPSTATION_API_SECRET"]);
  if (missing.length > 0) {
    return {
      key: "shipstation_credentials",
      label: "ShipStation credentials",
      status: "blocked",
      message: `ShipStation fulfillment handoff is missing ${missing.join(", ")}.`,
      requiredEnv: ["SHIPSTATION_API_KEY", "SHIPSTATION_API_SECRET"],
    };
  }

  return {
    key: "shipstation_credentials",
    label: "ShipStation credentials",
    status: "ready",
    message: "ShipStation API credentials are configured.",
    requiredEnv: ["SHIPSTATION_API_KEY", "SHIPSTATION_API_SECRET"],
  };
}

function buildShipStationWebhookSecurityCheck(env: NodeJS.ProcessEnv): DropshipSystemReadinessCheck {
  if (!hasEnv(env, "SHIPSTATION_WEBHOOK_SECRET")) {
    return {
      key: "shipstation_webhook_security",
      label: "ShipStation webhook security",
      status: "blocked",
      message: "SHIPSTATION_WEBHOOK_SECRET is required before ShipStation shipment webhooks can be accepted safely.",
      requiredEnv: ["SHIPSTATION_WEBHOOK_SECRET"],
    };
  }

  return {
    key: "shipstation_webhook_security",
    label: "ShipStation webhook security",
    status: "ready",
    message: "ShipStation webhook verification secret is configured.",
    requiredEnv: ["SHIPSTATION_WEBHOOK_SECRET"],
  };
}

function buildSplitShipmentHandoffCheck(env: NodeJS.ProcessEnv): DropshipSystemReadinessCheck {
  const requiredEnv = ["WMS_SHIPMENT_AT_SYNC=true", "PUSH_FROM_WMS=true", "SHIP_NOTIFY_V2=true"];
  const missing = [
    env.WMS_SHIPMENT_AT_SYNC === "true" ? null : "WMS_SHIPMENT_AT_SYNC=true",
    env.PUSH_FROM_WMS === "true" ? null : "PUSH_FROM_WMS=true",
    env.SHIP_NOTIFY_V2 === "true" ? null : "SHIP_NOTIFY_V2=true",
  ].filter((value): value is string => value !== null);

  if (missing.length > 0) {
    return {
      key: "split_shipment_handoff",
      label: "Split-shipment handoff",
      status: "blocked",
      message: `Shipment-aware WMS and ShipStation sync is missing ${missing.join(", ")}.`,
      requiredEnv,
    };
  }

  return {
    key: "split_shipment_handoff",
    label: "Split-shipment handoff",
    status: "ready",
    message: "WMS shipment creation, WMS-originated ShipStation push, and ShipStation V2 webhook rollups are enabled.",
    requiredEnv,
  };
}

function buildStripeFundingCheck(env: NodeJS.ProcessEnv): DropshipSystemReadinessCheck {
  const missing = missingEnv(env, ["STRIPE_SECRET_KEY"]);
  const hasWebhookSecret = hasEnv(env, "DROPSHIP_STRIPE_WEBHOOK_SECRET")
    || hasEnv(env, "STRIPE_DROPSHIP_WEBHOOK_SECRET")
    || hasEnv(env, "STRIPE_WEBHOOK_SECRET");
  if (!hasWebhookSecret) {
    missing.push("DROPSHIP_STRIPE_WEBHOOK_SECRET or STRIPE_DROPSHIP_WEBHOOK_SECRET or STRIPE_WEBHOOK_SECRET");
  }
  if (missing.length > 0) {
    return {
      key: "stripe_funding",
      label: "Stripe funding",
      status: "blocked",
      message: `Stripe wallet funding is missing ${missing.join(", ")}.`,
      requiredEnv: ["STRIPE_SECRET_KEY", "DROPSHIP_STRIPE_WEBHOOK_SECRET or STRIPE_DROPSHIP_WEBHOOK_SECRET or STRIPE_WEBHOOK_SECRET"],
    };
  }

  return {
    key: "stripe_funding",
    label: "Stripe funding",
    status: "ready",
    message: "Stripe wallet funding and webhook verification are configured.",
    requiredEnv: ["STRIPE_SECRET_KEY", "DROPSHIP_STRIPE_WEBHOOK_SECRET or STRIPE_DROPSHIP_WEBHOOK_SECRET or STRIPE_WEBHOOK_SECRET"],
  };
}

function buildUsdcBaseFundingCheck(): DropshipSystemReadinessCheck {
  return {
    key: "usdc_base_funding",
    label: "USDC Base funding",
    status: "ready",
    message: "USDC Base confirmed-transfer funding method registration, ledger capture, and admin confirmed-credit flow are available.",
    requiredEnv: [],
  };
}

function isValidTokenEncryptionKey(rawKey: string): boolean {
  if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
    return Buffer.from(rawKey, "hex").length === 32;
  }
  try {
    return Buffer.from(rawKey, "base64").length === 32;
  } catch {
    return false;
  }
}

function firstConfiguredEnv(env: NodeJS.ProcessEnv, keys: string[]): string | null {
  return keys.find((key) => hasEnv(env, key)) ?? null;
}

function missingEnv(env: NodeJS.ProcessEnv, keys: string[]): string[] {
  return keys.filter((key) => !hasEnv(env, key));
}

function hasEnv(env: NodeJS.ProcessEnv, key: string): boolean {
  return Boolean(env[key]?.trim());
}

function isValidHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function buildDropshipSettingsSections(input: {
  vendorStatus: string;
  entitlementStatus: string;
  storeConnections: DropshipVendorSettingsOverview["storeConnections"];
  wallet: DropshipVendorSettingsOverview["wallet"];
  notificationPreferenceCount: number;
  hasContactEmail: boolean;
}): DropshipOpsSettingsSection[] {
  const storeBlockers = input.storeConnections.length === 0
    ? ["store_connection_required"]
    : input.storeConnections.flatMap((connection) => {
      const blockers: string[] = [];
      if (connection.status !== "connected") blockers.push(`store_${connection.status}`);
      if (connection.setupStatus !== "ready") blockers.push(`setup_${connection.setupStatus}`);
      if (!isLaunchSupportedStorePlatform(connection.platform)) blockers.push(`store_platform_${connection.platform}`);
      if (!connection.hasAccessToken) blockers.push("store_access_token_required");
      if (requiresStoreRefreshTokenForLaunch(connection.platform) && !connection.hasRefreshToken) {
        blockers.push("store_refresh_token_required");
      }
      return blockers;
    });
  const launchReadyStoreCount = input.storeConnections.filter((connection) => connection.launchReady).length;
  const walletBlockers = [
    input.wallet.autoReloadEnabled ? null : "auto_reload_required",
    input.wallet.autoReloadEnabled && !input.wallet.autoReloadFundingMethodReady
      ? "auto_reload_funding_method_required"
      : null,
    input.wallet.availableBalanceCents > 0 || input.wallet.activeStripeFundingMethodCount > 0
      ? null
      : "stripe_funding_method_required",
    input.wallet.activeUsdcBaseFundingMethodCount > 0
      ? null
      : "usdc_base_funding_method_required",
  ].filter((value): value is string => value !== null);
  const walletReady = walletBlockers.length === 0;
  const walletAttentionSummary = !input.wallet.autoReloadEnabled
    ? "Auto-reload needs setup."
    : !input.wallet.autoReloadFundingMethodReady
      ? "Auto-reload needs usable Stripe funding."
      : input.wallet.activeUsdcBaseFundingMethodCount <= 0
        ? "USDC Base funding needs setup."
        : "Wallet funding needs setup.";

  return [
    {
      key: "account",
      label: "Account",
      status: input.vendorStatus === "active" && input.entitlementStatus === "active" ? "ready" : "attention_required",
      comingSoon: false,
      summary: input.entitlementStatus === "active" ? "Membership entitlement active." : "Membership entitlement needs attention.",
      blockers: input.entitlementStatus === "active" ? [] : [`entitlement_${input.entitlementStatus}`],
    },
    {
      key: "store_connection",
      label: "Store connection",
      status: storeBlockers.length === 0 && launchReadyStoreCount > 0 ? "ready" : "attention_required",
      comingSoon: false,
      summary: buildStoreConnectionSettingsSummary(input.storeConnections, launchReadyStoreCount),
      blockers: storeBlockers,
    },
    {
      key: "wallet_payment",
      label: "Wallet and payment",
      status: walletReady ? "ready" : "attention_required",
      comingSoon: false,
      summary: walletReady
        ? "Wallet funding, USDC Base, and auto-reload ready."
        : walletAttentionSummary,
      blockers: walletBlockers,
    },
    {
      key: "notifications",
      label: "Notifications",
      status: "ready",
      comingSoon: false,
      summary: `${DROPSHIP_LAUNCH_NOTIFICATION_PREFERENCES.length} launch default notification preference(s) available; ${input.notificationPreferenceCount} vendor override(s) configured.`,
      blockers: [],
    },
    {
      key: "api_keys",
      label: "API keys",
      status: "coming_soon",
      comingSoon: true,
      summary: "Coming soon in Phase 2.",
      blockers: [],
    },
    {
      key: "webhooks",
      label: "Webhooks",
      status: "coming_soon",
      comingSoon: true,
      summary: "Coming soon in Phase 2.",
      blockers: [],
    },
    {
      key: "return_contact",
      label: "Return/contact display",
      status: input.hasContactEmail ? "ready" : "attention_required",
      comingSoon: false,
      summary: input.hasContactEmail ? "Contact email available." : "Contact email is missing.",
      blockers: input.hasContactEmail ? [] : ["contact_email_required"],
    },
  ];
}

function buildStoreConnectionSettingsSummary(
  storeConnections: DropshipVendorSettingsOverview["storeConnections"],
  launchReadyStoreCount: number,
): string {
  if (storeConnections.length === 0) {
    return "No store connection configured.";
  }
  if (launchReadyStoreCount > 0) {
    return `${launchReadyStoreCount} launch-ready store connection configured.`;
  }
  return "Store connection needs launch-ready credentials.";
}

function requiresStoreRefreshTokenForLaunch(platform: string): boolean {
  return platform === "ebay";
}

function isLaunchSupportedStorePlatform(platform: string): boolean {
  return platform === "ebay" || platform === "shopify";
}

export function makeDropshipOpsSurfaceLogger(): DropshipLogger {
  return {
    info: (event) => logDropshipOpsSurfaceEvent("info", event),
    warn: (event) => logDropshipOpsSurfaceEvent("warn", event),
    error: (event) => logDropshipOpsSurfaceEvent("error", event),
  };
}

export const systemDropshipOpsSurfaceClock: DropshipClock = {
  now: () => new Date(),
};

function parseOpsSurfaceInput<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown, code: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new DropshipError(code, "Dropship ops surface input failed validation.", {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
        message: issue.message,
      })),
    });
  }
  return result.data;
}

function logDropshipOpsSurfaceEvent(level: "info" | "warn" | "error", event: DropshipLogEvent): void {
  const payload = JSON.stringify({
    code: event.code,
    message: event.message,
    context: event.context ?? {},
  });
  if (level === "error") {
    console.error(payload);
  } else if (level === "warn") {
    console.warn(payload);
  } else {
    console.info(payload);
  }
}
