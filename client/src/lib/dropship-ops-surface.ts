export type DropshipSectionStatus = "ready" | "attention_required" | "coming_soon";
export type DropshipSeverity = "info" | "warning" | "error";

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

export async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response));
  }
  return response.json() as Promise<T>;
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
