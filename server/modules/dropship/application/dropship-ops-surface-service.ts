import { z } from "zod";
import { DropshipError } from "../domain/errors";
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
    updatedAt: Date;
  }>;
  wallet: {
    availableBalanceCents: number;
    pendingBalanceCents: number;
    autoReloadEnabled: boolean;
    fundingMethodCount: number;
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
    autoReloadEnabled: boolean;
    notificationPreferenceCount: number;
  };
}

export interface DropshipDogfoodReadinessSummary {
  status: DropshipDogfoodReadinessStatus;
  count: number;
}

export interface DropshipDogfoodReadinessResult {
  generatedAt: Date;
  items: DropshipDogfoodReadinessItem[];
  total: number;
  page: number;
  limit: number;
  summary: DropshipDogfoodReadinessSummary[];
  systemChecks: DropshipSystemReadinessCheck[];
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
      ...result,
      systemChecks: buildDropshipSystemReadinessChecks(process.env),
    };
  }
}

export function buildDropshipSystemReadinessChecks(
  env: NodeJS.ProcessEnv,
): DropshipSystemReadinessCheck[] {
  return [
    buildTokenVaultCheck(env),
    buildOAuthStateCheck(env),
    buildEbayOAuthCheck(env),
    buildShopifyOAuthCheck(env),
    buildStripeFundingCheck(env),
  ];
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
      status: "warning",
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
      return blockers;
    });
  const walletBlockers = [
    input.wallet.autoReloadEnabled ? null : "auto_reload_required",
    input.wallet.fundingMethodCount > 0 ? null : "funding_method_required",
  ].filter((value): value is string => value !== null);

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
      status: storeBlockers.length === 0 ? "ready" : "attention_required",
      comingSoon: false,
      summary: input.storeConnections.length > 0
        ? `${input.storeConnections.length} store connection configured.`
        : "No store connection configured.",
      blockers: storeBlockers,
    },
    {
      key: "wallet_payment",
      label: "Wallet and payment",
      status: walletBlockers.length === 0 ? "ready" : "attention_required",
      comingSoon: false,
      summary: input.wallet.autoReloadEnabled ? "Auto-reload enabled." : "Auto-reload needs setup.",
      blockers: walletBlockers,
    },
    {
      key: "notifications",
      label: "Notifications",
      status: "ready",
      comingSoon: false,
      summary: `${input.notificationPreferenceCount} notification preference override(s) configured.`,
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
