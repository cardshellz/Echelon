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

export type SearchDropshipAuditEventsInput = z.infer<typeof searchAuditEventsInputSchema>;
export type GetDropshipAdminOpsOverviewInput = z.infer<typeof adminOpsOverviewInputSchema>;

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

export interface DropshipOpsSurfaceRepository {
  getVendorSettingsOverview(vendorId: number, generatedAt: Date): Promise<DropshipVendorSettingsOverview>;
  getAdminOpsOverview(
    input: GetDropshipAdminOpsOverviewInput & { generatedAt: Date },
  ): Promise<DropshipAdminOpsOverview>;
  searchAuditEvents(input: SearchDropshipAuditEventsInput): Promise<DropshipAuditEventSearchResult>;
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
