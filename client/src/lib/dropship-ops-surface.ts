export type DropshipSectionStatus = "ready" | "attention_required" | "coming_soon";
export type DropshipSeverity = "info" | "warning" | "error";
export type DropshipStorePlatform = "ebay" | "shopify";

export interface DropshipSettingsSection {
  key: "account" | "store_connection" | "wallet_payment" | "notifications" | "api_keys" | "webhooks" | "return_contact";
  label: string;
  status: DropshipSectionStatus;
  comingSoon: boolean;
  summary: string;
  blockers: string[];
}

export interface DropshipStoreConnectionSummary {
  storeConnectionId: number;
  platform: string;
  status: string;
  setupStatus: string;
  externalDisplayName: string | null;
  shopDomain: string | null;
  updatedAt: string;
}

export interface DropshipOnboardingStep {
  key: "vendor_profile" | "store_connection" | "catalog_available" | "catalog_selection";
  label: string;
  status: "complete" | "incomplete" | "blocked";
  required: boolean;
}

export interface DropshipOnboardingState {
  vendor: {
    vendorId: number;
    memberId: string;
    businessName: string | null;
    contactName: string | null;
    email: string | null;
    phone: string | null;
    status: string;
    entitlementStatus: string;
    membershipGraceEndsAt: string | null;
    includedStoreConnections: number;
  };
  entitlement: {
    memberId: string;
    cardShellzEmail: string | null;
    status: "active" | "grace" | "lapsed" | "suspended" | "not_entitled";
    planId: string | null;
    planName: string | null;
    subscriptionId: string | null;
    includesDropship: boolean;
    reasonCode: string;
  };
  storeConnections: {
    activeCount: number;
    connectedCount: number;
    needsAttentionCount: number;
    totalCount: number;
    includedLimit: number;
    canConnectStore: boolean;
  };
  catalog: {
    adminExposureRuleCount: number;
    vendorSelectionRuleCount: number;
    adminCatalogAvailable: boolean;
    hasVendorSelection: boolean;
  };
  steps: DropshipOnboardingStep[];
}

export interface DropshipStoreConnectionOAuthStartInput {
  platform: DropshipStorePlatform;
  shopDomain?: string;
  returnTo?: string;
}

export interface DropshipStoreConnectionOAuthStartResponse {
  authorizationUrl: string;
  platform: DropshipStorePlatform;
  shopDomain: string | null;
  expiresAt: string;
  scopes: string[];
  environment: string;
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
  storeConnections: DropshipStoreConnectionSummary[];
  wallet: {
    availableBalanceCents: number;
    pendingBalanceCents: number;
    autoReloadEnabled: boolean;
    fundingMethodCount: number;
  };
  notificationPreferences: {
    configuredCount: number;
  };
  sections: DropshipSettingsSection[];
  generatedAt: string;
}

export interface DropshipSettingsResponse {
  settings: DropshipVendorSettingsOverview;
}

export interface DropshipOpsCount {
  key: string;
  count: number;
}

export interface DropshipOpsRiskBucket {
  key: string;
  label: string;
  severity: DropshipSeverity;
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
  severity: DropshipSeverity;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface DropshipAdminOpsOverview {
  generatedAt: string;
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

export interface DropshipAdminOpsOverviewResponse {
  overview: DropshipAdminOpsOverview;
}

export interface DropshipAuditEventSearchResponse {
  items: DropshipAuditEventRecord[];
  total: number;
  page: number;
  limit: number;
}

export interface DropshipCatalogSelectionDecision {
  selected: boolean;
  reason: string;
  marketplaceQuantity: number;
  quantityCapApplied: boolean;
  autoConnectNewSkus: boolean;
  autoListNewSkus: boolean;
}

export interface DropshipCatalogRow {
  productId: number;
  productVariantId: number;
  productSku: string | null;
  productName: string;
  variantSku: string | null;
  variantName: string;
  category: string | null;
  productLineNames: string[];
  unitsPerVariant: number;
  selectionDecision: DropshipCatalogSelectionDecision;
}

export interface DropshipCatalogResponse {
  rows: DropshipCatalogRow[];
  total: number;
  page: number;
  limit: number;
}

export type DropshipVendorSelectionScope = "catalog" | "product_line" | "category" | "product" | "variant";
export type DropshipVendorSelectionAction = "include" | "exclude";

export interface DropshipVendorSelectionRule {
  id?: number;
  revisionId?: number | null;
  vendorId?: number;
  scopeType: DropshipVendorSelectionScope;
  action: DropshipVendorSelectionAction;
  productLineId?: number | null;
  productId?: number | null;
  productVariantId?: number | null;
  category?: string | null;
  autoConnectNewSkus?: boolean;
  autoListNewSkus?: boolean;
  priority?: number;
  metadata?: Record<string, unknown> | null;
  isActive?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface DropshipVendorSelectionRuleInput {
  scopeType: DropshipVendorSelectionScope;
  action: DropshipVendorSelectionAction;
  productLineId?: number | null;
  productId?: number | null;
  productVariantId?: number | null;
  category?: string | null;
  autoConnectNewSkus: boolean;
  autoListNewSkus: boolean;
  priority: number;
  metadata?: Record<string, unknown>;
}

export interface DropshipSelectionRulesResponse {
  rules: DropshipVendorSelectionRule[];
}

export interface DropshipSelectionRulesReplaceResponse {
  revisionId: number;
  idempotentReplay: boolean;
  rules: DropshipVendorSelectionRule[];
}

export interface DropshipOrderListItem {
  intakeId: number;
  platform: string;
  externalOrderId: string;
  externalOrderNumber: string | null;
  status: string;
  paymentHoldExpiresAt: string | null;
  rejectionReason: string | null;
  cancellationStatus: string | null;
  omsOrderId: number | null;
  receivedAt: string;
  acceptedAt: string | null;
  updatedAt: string;
  lineCount: number;
  totalQuantity: number;
  shipTo: {
    name?: string;
    company?: string;
    city?: string;
    region?: string;
    postalCode?: string;
    country?: string;
  } | null;
  storeConnection: {
    storeConnectionId: number;
    platform: string;
    status: string;
    setupStatus: string;
    externalDisplayName: string | null;
    shopDomain: string | null;
  };
}

export interface DropshipOrderListResponse {
  items: DropshipOrderListItem[];
  total: number;
  page: number;
  limit: number;
  statuses: string[];
  summary: Array<{ status: string; count: number }>;
}

export interface DropshipWalletResponse {
  wallet: {
    account: {
      walletAccountId: number;
      vendorId: number;
      availableBalanceCents: number;
      pendingBalanceCents: number;
      currency: string;
      status: string;
      createdAt: string;
      updatedAt: string;
    };
    autoReload: {
      autoReloadSettingId: number;
      enabled: boolean;
      minimumBalanceCents: number;
      maxSingleReloadCents: number | null;
      paymentHoldTimeoutMinutes: number;
      fundingMethodId: number | null;
      updatedAt: string;
    } | null;
    fundingMethods: Array<{
      fundingMethodId: number;
      rail: string;
      status: string;
      displayLabel: string | null;
      isDefault: boolean;
      createdAt: string;
      updatedAt: string;
    }>;
    recentLedger: Array<{
      ledgerEntryId: number;
      type: string;
      status: string;
      amountCents: number;
      currency: string;
      availableBalanceAfterCents: number | null;
      pendingBalanceAfterCents: number | null;
      referenceType: string | null;
      referenceId: string | null;
      createdAt: string;
      settledAt: string | null;
    }>;
  };
}

export interface DropshipReturnListItem {
  rmaId: number;
  rmaNumber: string;
  status: string;
  reasonCode: string | null;
  faultCategory: string | null;
  returnWindowDays: number;
  returnTrackingNumber: string | null;
  requestedAt: string;
  receivedAt: string | null;
  inspectedAt: string | null;
  creditedAt: string | null;
  updatedAt: string;
  itemCount: number;
  totalQuantity: number;
  platform: string | null;
  intakeId: number | null;
  omsOrderId: number | null;
}

export interface DropshipReturnListResponse {
  items: DropshipReturnListItem[];
  total: number;
  page: number;
  limit: number;
}

export interface DropshipNotificationListResponse {
  items: Array<{
    notificationEventId: number;
    eventType: string;
    channel: "email" | "in_app";
    critical: boolean;
    title: string;
    message: string | null;
    status: string;
    deliveredAt: string | null;
    readAt: string | null;
    createdAt: string;
  }>;
  total: number;
  page: number;
  limit: number;
  unreadOnly: boolean;
}

export function buildQueryUrl(path: string, params: Record<string, string | number | boolean | undefined | null>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    query.set(key, String(value));
  }
  const queryString = query.toString();
  return queryString ? `${path}?${queryString}` : path;
}

export async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response));
  }
  return response.json() as Promise<T>;
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response));
  }
  return response.json() as Promise<T>;
}

export async function putJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response));
  }
  return response.json() as Promise<T>;
}

export function buildStoreConnectionOAuthStartInput(input: {
  platform: DropshipStorePlatform;
  shopDomain: string;
  returnTo: string;
}): DropshipStoreConnectionOAuthStartInput {
  const returnTo = normalizePortalReturnPath(input.returnTo);
  if (input.platform === "ebay") {
    return { platform: input.platform, returnTo };
  }

  return {
    platform: input.platform,
    shopDomain: normalizeShopifyShopDomainInput(input.shopDomain),
    returnTo,
  };
}

export function normalizeShopifyShopDomainInput(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!normalized) return "";
  return normalized.includes(".") ? normalized : `${normalized}.myshopify.com`;
}

export function normalizePortalReturnPath(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length > 500 ||
    !normalized.startsWith("/") ||
    normalized.startsWith("//") ||
    normalized.includes("\\") ||
    /^[a-z][a-z0-9+.-]*:/i.test(normalized)
  ) {
    throw new Error("Return path must be a relative portal path.");
  }
  return normalized;
}

export function createDropshipIdempotencyKey(prefix: string): string {
  if (crypto.randomUUID) return `${prefix}:${crypto.randomUUID()}`;
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}:${suffix}`;
}

export function buildVariantSelectionReplacement(input: {
  existingRules: readonly DropshipVendorSelectionRule[];
  rows: readonly DropshipCatalogRow[];
  action: DropshipVendorSelectionAction;
}): DropshipVendorSelectionRuleInput[] {
  const variantIds = uniquePositiveVariantIds(input.rows);
  const activeRules = input.existingRules
    .filter((rule) => rule.isActive !== false)
    .map(toReplaceableSelectionRule)
    .filter((rule) => !isTargetedVariantRule(rule, variantIds));

  const actionRules = Array.from(variantIds).map((productVariantId) => ({
    scopeType: "variant" as const,
    action: input.action,
    productLineId: null,
    productId: null,
    productVariantId,
    category: null,
    autoConnectNewSkus: input.action === "include",
    autoListNewSkus: false,
    priority: input.action === "include" ? 100 : 200,
    metadata: {
      source: "portal_catalog",
    },
  }));

  return [...activeRules, ...actionRules];
}

function toReplaceableSelectionRule(rule: DropshipVendorSelectionRule): DropshipVendorSelectionRuleInput {
  return {
    scopeType: rule.scopeType,
    action: rule.action,
    productLineId: rule.productLineId ?? null,
    productId: rule.productId ?? null,
    productVariantId: rule.productVariantId ?? null,
    category: rule.category?.trim() || null,
    autoConnectNewSkus: rule.autoConnectNewSkus !== false,
    autoListNewSkus: rule.autoListNewSkus === true,
    priority: Number.isInteger(rule.priority) ? rule.priority! : 0,
    metadata: rule.metadata ?? {},
  };
}

function isTargetedVariantRule(rule: DropshipVendorSelectionRuleInput, variantIds: ReadonlySet<number>): boolean {
  return rule.scopeType === "variant"
    && typeof rule.productVariantId === "number"
    && variantIds.has(rule.productVariantId);
}

function uniquePositiveVariantIds(rows: readonly DropshipCatalogRow[]): Set<number> {
  const ids = rows
    .map((row) => row.productVariantId)
    .filter((id) => Number.isInteger(id) && id > 0);
  return new Set(ids);
}

export function formatCents(cents: number): string {
  if (!Number.isSafeInteger(cents)) return "$0.00";
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  const dollars = Math.trunc(absolute / 100);
  const remainder = absolute % 100;
  return `${sign}$${dollars.toLocaleString("en-US")}.${String(remainder).padStart(2, "0")}`;
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "None";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function formatStatus(value: string | null | undefined): string {
  if (!value) return "Unknown";
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function sectionStatusTone(status: DropshipSectionStatus): string {
  if (status === "ready") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "coming_soon") return "border-zinc-200 bg-zinc-50 text-zinc-600";
  return "border-amber-200 bg-amber-50 text-amber-900";
}

export function riskSeverityTone(severity: DropshipSeverity): string {
  if (severity === "error") return "border-rose-200 bg-rose-50 text-rose-800";
  if (severity === "warning") return "border-amber-200 bg-amber-50 text-amber-900";
  return "border-zinc-200 bg-zinc-50 text-zinc-700";
}

export function countByKey(counts: DropshipOpsCount[], key: string): number {
  return counts.find((count) => count.key === key)?.count ?? 0;
}

async function responseErrorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json();
    if (typeof body?.error?.message === "string") {
      return body.error.message;
    }
  } catch {
    // Fall through to status text.
  }
  return response.statusText || `Request failed with ${response.status}`;
}
