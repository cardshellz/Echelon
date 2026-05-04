export type DropshipSectionStatus = "ready" | "attention_required" | "coming_soon";
export type DropshipSeverity = "info" | "warning" | "error";
export type DropshipStorePlatform = "ebay" | "shopify";
export type DropshipDogfoodReadinessStatus = "ready" | "warning" | "blocked";
export type DropshipListingMode = "draft_first" | "live" | "manual_only";
export type DropshipListingInventoryMode = "managed_quantity_sync" | "manual_quantity" | "disabled";
export type DropshipListingPriceMode = "vendor_defined" | "connection_default" | "disabled";
export type DropshipListingRequiredProductField =
  | "sku"
  | "productName"
  | "variantName"
  | "title"
  | "description"
  | "category"
  | "brand"
  | "gtin"
  | "mpn"
  | "condition"
  | "itemSpecifics"
  | "imageUrls";
export type DropshipCatalogExposureScope = "catalog" | "product_line" | "category" | "product" | "variant";
export type DropshipCatalogExposureAction = "include" | "exclude";
export type DropshipOpsOrderIntakeStatus =
  | "received"
  | "processing"
  | "accepted"
  | "rejected"
  | "retrying"
  | "failed"
  | "payment_hold"
  | "cancelled"
  | "exception";
export type DropshipListingPushJobStatus =
  | "queued"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";
export type DropshipTrackingPushStatus =
  | "queued"
  | "processing"
  | "succeeded"
  | "failed";
export type DropshipNotificationOpsStatus =
  | "pending"
  | "delivered"
  | "failed";
export type DropshipNotificationOpsChannel =
  | "email"
  | "in_app";
export type DropshipRmaStatus =
  | "requested"
  | "in_transit"
  | "received"
  | "inspecting"
  | "approved"
  | "rejected"
  | "credited"
  | "closed";
export type DropshipReturnFaultCategory =
  | "card_shellz"
  | "vendor"
  | "customer"
  | "marketplace"
  | "carrier";
export type DropshipStoreConnectionLifecycleStatus =
  | "connected"
  | "needs_reauth"
  | "refresh_failed"
  | "grace_period"
  | "paused"
  | "disconnected";

const allDropshipOpsOrderIntakeStatuses: DropshipOpsOrderIntakeStatus[] = [
  "received",
  "processing",
  "accepted",
  "rejected",
  "retrying",
  "failed",
  "payment_hold",
  "cancelled",
  "exception",
];

const allDropshipListingPushJobStatuses: DropshipListingPushJobStatus[] = [
  "queued",
  "processing",
  "completed",
  "failed",
  "cancelled",
];

const allDropshipTrackingPushStatuses: DropshipTrackingPushStatus[] = [
  "queued",
  "processing",
  "succeeded",
  "failed",
];

const allDropshipNotificationOpsStatuses: DropshipNotificationOpsStatus[] = [
  "pending",
  "delivered",
  "failed",
];

const allDropshipRmaStatuses: DropshipRmaStatus[] = [
  "requested",
  "in_transit",
  "received",
  "inspecting",
  "approved",
  "rejected",
  "credited",
  "closed",
];

export const allDropshipListingModes: DropshipListingMode[] = ["draft_first", "live", "manual_only"];
export const allDropshipListingInventoryModes: DropshipListingInventoryMode[] = [
  "managed_quantity_sync",
  "manual_quantity",
  "disabled",
];
export const allDropshipListingPriceModes: DropshipListingPriceMode[] = [
  "vendor_defined",
  "connection_default",
  "disabled",
];
export const allDropshipListingRequiredProductFields: DropshipListingRequiredProductField[] = [
  "sku",
  "productName",
  "variantName",
  "title",
  "description",
  "category",
  "brand",
  "gtin",
  "mpn",
  "condition",
  "itemSpecifics",
  "imageUrls",
];

const defaultDropshipRmaOpsStatuses: DropshipRmaStatus[] = [
  "requested",
  "in_transit",
  "received",
  "inspecting",
  "approved",
  "rejected",
];

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

export interface DropshipDogfoodReadinessCheck {
  key: string;
  label: string;
  status: DropshipDogfoodReadinessStatus;
  message: string;
}

export interface DropshipSystemReadinessCheck {
  key: string;
  label: string;
  status: DropshipDogfoodReadinessStatus;
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
    updatedAt: string | null;
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

export interface DropshipDogfoodReadinessResponse {
  generatedAt: string;
  items: DropshipDogfoodReadinessItem[];
  total: number;
  page: number;
  limit: number;
  summary: Array<{ status: DropshipDogfoodReadinessStatus; count: number }>;
  systemChecks: DropshipSystemReadinessCheck[];
}

export interface DropshipOmsChannelOption {
  channelId: number;
  name: string;
  type: string;
  provider: string;
  status: string;
  isDropshipOmsChannel: boolean;
  markerSources: string[];
  updatedAt: string;
}

export interface DropshipOmsChannelConfigOverview {
  currentChannelId: number | null;
  currentChannelCount: number;
  channels: DropshipOmsChannelOption[];
  generatedAt: string;
}

export interface DropshipAdminOmsChannelConfigResponse {
  config: DropshipOmsChannelConfigOverview;
}

export interface DropshipAdminOmsChannelConfigureInput {
  channelId: number;
  idempotencyKey: string;
}

export interface DropshipAdminOmsChannelConfigureResponse {
  config: DropshipOmsChannelConfigOverview;
  selectedChannel: DropshipOmsChannelOption;
  idempotentReplay: boolean;
}

export interface DropshipShippingBoxConfig {
  boxId: number;
  code: string;
  name: string;
  lengthMm: number;
  widthMm: number;
  heightMm: number;
  tareWeightGrams: number;
  maxWeightGrams: number | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DropshipShippingPackageProfileConfig {
  packageProfileId: number;
  productVariantId: number;
  productSku: string | null;
  productName: string | null;
  variantSku: string | null;
  variantName: string | null;
  weightGrams: number;
  lengthMm: number;
  widthMm: number;
  heightMm: number;
  shipAlone: boolean;
  defaultCarrier: string | null;
  defaultService: string | null;
  defaultBoxId: number | null;
  maxUnitsPerPackage: number | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DropshipShippingZoneRuleConfig {
  zoneRuleId: number;
  originWarehouseId: number;
  destinationCountry: string;
  destinationRegion: string | null;
  postalPrefix: string | null;
  zone: string;
  priority: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DropshipShippingRateTableRowConfig {
  rateTableRowId: number;
  rateTableId: number;
  warehouseId: number | null;
  destinationZone: string;
  minWeightGrams: number;
  maxWeightGrams: number;
  rateCents: number;
  createdAt: string;
}

export interface DropshipShippingRateTableConfig {
  rateTableId: number;
  carrier: string;
  service: string;
  currency: string;
  status: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  rows: DropshipShippingRateTableRowConfig[];
}

export interface DropshipShippingMarkupPolicyConfig {
  policyId: number;
  name: string;
  markupBps: number;
  fixedMarkupCents: number;
  minMarkupCents: number | null;
  maxMarkupCents: number | null;
  isActive: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
}

export interface DropshipShippingInsurancePolicyConfig {
  policyId: number;
  name: string;
  feeBps: number;
  minFeeCents: number | null;
  maxFeeCents: number | null;
  isActive: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
}

export interface DropshipShippingConfigOverview {
  boxes: DropshipShippingBoxConfig[];
  packageProfiles: DropshipShippingPackageProfileConfig[];
  zoneRules: DropshipShippingZoneRuleConfig[];
  rateTables: DropshipShippingRateTableConfig[];
  activeMarkupPolicy: DropshipShippingMarkupPolicyConfig | null;
  activeInsurancePolicy: DropshipShippingInsurancePolicyConfig | null;
  generatedAt: string;
}

export interface DropshipAdminShippingConfigResponse {
  config: DropshipShippingConfigOverview;
}

export interface DropshipShippingBoxInput {
  boxId?: number;
  code: string;
  name: string;
  lengthMm: number;
  widthMm: number;
  heightMm: number;
  tareWeightGrams: number;
  maxWeightGrams: number | null;
  isActive: boolean;
  idempotencyKey: string;
}

export interface DropshipShippingPackageProfileInput {
  productVariantId: number;
  weightGrams: number;
  lengthMm: number;
  widthMm: number;
  heightMm: number;
  shipAlone: boolean;
  defaultCarrier: string | null;
  defaultService: string | null;
  defaultBoxId: number | null;
  maxUnitsPerPackage: number | null;
  isActive: boolean;
  idempotencyKey: string;
}

export interface DropshipShippingZoneRuleInput {
  zoneRuleId?: number;
  originWarehouseId: number;
  destinationCountry: string;
  destinationRegion: string | null;
  postalPrefix: string | null;
  zone: string;
  priority: number;
  isActive: boolean;
  idempotencyKey: string;
}

export interface DropshipShippingRateTableInput {
  carrier: string;
  service: string;
  currency: string;
  status: "draft" | "active" | "archived";
  effectiveFrom?: string;
  effectiveTo: string | null;
  rows: Array<{
    warehouseId: number | null;
    destinationZone: string;
    minWeightGrams: number;
    maxWeightGrams: number;
    rateCents: number;
  }>;
  metadata: Record<string, unknown>;
  idempotencyKey: string;
}

export interface DropshipShippingMarkupPolicyInput {
  name: string;
  markupBps: number;
  fixedMarkupCents: number;
  minMarkupCents: number | null;
  maxMarkupCents: number | null;
  isActive: boolean;
  effectiveFrom?: string;
  effectiveTo: string | null;
  idempotencyKey: string;
}

export interface DropshipShippingInsurancePolicyInput {
  name: string;
  feeBps: number;
  minFeeCents: number | null;
  maxFeeCents: number | null;
  isActive: boolean;
  effectiveFrom?: string;
  effectiveTo: string | null;
  idempotencyKey: string;
}

export interface DropshipCatalogExposureDecision {
  exposed: boolean;
  reason: string;
  includeRuleIds: number[];
  excludeRuleIds: number[];
}

export interface DropshipAdminCatalogExposureRule {
  id?: number;
  revisionId?: number | null;
  scopeType: DropshipCatalogExposureScope;
  action: DropshipCatalogExposureAction;
  productLineId: number | null;
  productId: number | null;
  productVariantId: number | null;
  category: string | null;
  priority: number;
  startsAt?: string | null;
  endsAt?: string | null;
  isActive?: boolean;
  notes: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface DropshipAdminCatalogExposureRuleInput {
  scopeType: DropshipCatalogExposureScope;
  action: DropshipCatalogExposureAction;
  productLineId: number | null;
  productId: number | null;
  productVariantId: number | null;
  category: string | null;
  priority: number;
  startsAt: string | null;
  endsAt: string | null;
  notes: string | null;
  metadata: Record<string, unknown>;
}

export interface DropshipAdminCatalogExposureRulesResponse {
  rules: DropshipAdminCatalogExposureRule[];
}

export interface DropshipAdminCatalogExposureRulesReplaceResponse {
  revisionId: number;
  idempotentReplay: boolean;
  rules: DropshipAdminCatalogExposureRule[];
}

export interface DropshipAdminCatalogExposurePreviewRow {
  productId: number;
  productVariantId: number;
  productLineIds: number[];
  category: string | null;
  productIsActive: boolean;
  variantIsActive: boolean;
  productSku: string | null;
  productName: string;
  variantSku: string | null;
  variantName: string;
  productLineNames: string[];
  decision: DropshipCatalogExposureDecision;
}

export interface DropshipAdminCatalogExposurePreviewResponse {
  rows: DropshipAdminCatalogExposurePreviewRow[];
  total: number;
  page: number;
  limit: number;
}

export interface DropshipAdminOrderOpsVendorSummary {
  vendorId: number;
  memberId: string;
  businessName: string | null;
  email: string | null;
  status: string;
  entitlementStatus: string;
}

export interface DropshipAdminOrderOpsStoreSummary {
  storeConnectionId: number;
  platform: string;
  status: string;
  setupStatus: string;
  externalDisplayName: string | null;
  shopDomain: string | null;
}

export interface DropshipAdminOrderOpsAuditSummary {
  eventType: string;
  severity: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface DropshipAdminOrderOpsIntakeListItem {
  intakeId: number;
  vendor: DropshipAdminOrderOpsVendorSummary;
  storeConnection: DropshipAdminOrderOpsStoreSummary;
  platform: string;
  externalOrderId: string;
  externalOrderNumber: string | null;
  status: DropshipOpsOrderIntakeStatus;
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
  latestAuditEvent: DropshipAdminOrderOpsAuditSummary | null;
}

export interface DropshipAdminOrderOpsListResponse {
  items: DropshipAdminOrderOpsIntakeListItem[];
  total: number;
  page: number;
  limit: number;
  statuses: DropshipOpsOrderIntakeStatus[];
  summary: Array<{ status: DropshipOpsOrderIntakeStatus; count: number }>;
}

export interface DropshipAdminListingPushJobListItem {
  jobId: number;
  vendor: DropshipAdminOrderOpsVendorSummary;
  storeConnection: DropshipAdminOrderOpsStoreSummary;
  platform: string;
  status: DropshipListingPushJobStatus;
  jobType: string;
  requestedBy: string | null;
  requestedScope: Record<string, unknown> | null;
  idempotencyKey: string | null;
  requestHash: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  itemSummary: {
    total: number;
    queued: number;
    processing: number;
    completed: number;
    failed: number;
    blocked: number;
    cancelled: number;
  };
  latestItemError: {
    itemId: number;
    productVariantId: number;
    status: string;
    errorCode: string | null;
    errorMessage: string | null;
    updatedAt: string;
  } | null;
}

export interface DropshipAdminListingPushJobListResponse {
  items: DropshipAdminListingPushJobListItem[];
  total: number;
  page: number;
  limit: number;
  statuses: DropshipListingPushJobStatus[];
  summary: Array<{ status: DropshipListingPushJobStatus; count: number }>;
}

export interface DropshipAdminTrackingPushListItem {
  pushId: number;
  intakeId: number;
  omsOrderId: number;
  wmsShipmentId: number | null;
  vendor: DropshipAdminOrderOpsVendorSummary;
  storeConnection: DropshipAdminOrderOpsStoreSummary;
  platform: string;
  externalOrderId: string;
  externalOrderNumber: string | null;
  sourceOrderId: string | null;
  status: DropshipTrackingPushStatus;
  idempotencyKey: string;
  requestHash: string;
  carrier: string;
  trackingNumber: string;
  shippedAt: string;
  externalFulfillmentId: string | null;
  attemptCount: number;
  retryable: boolean;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface DropshipAdminTrackingPushListResponse {
  items: DropshipAdminTrackingPushListItem[];
  total: number;
  page: number;
  limit: number;
  statuses: DropshipTrackingPushStatus[];
  summary: Array<{ status: DropshipTrackingPushStatus; count: number }>;
}

export type DropshipAdminNotificationOpsVendorSummary = DropshipAdminOrderOpsVendorSummary;

export interface DropshipAdminNotificationOpsListItem {
  notificationEventId: number;
  vendor: DropshipAdminNotificationOpsVendorSummary;
  eventType: string;
  channel: DropshipNotificationOpsChannel;
  critical: boolean;
  title: string;
  message: string | null;
  payload: Record<string, unknown>;
  status: DropshipNotificationOpsStatus;
  deliveredAt: string | null;
  readAt: string | null;
  idempotencyKey: string | null;
  requestHash: string | null;
  createdAt: string;
}

export interface DropshipAdminNotificationOpsListResponse {
  items: DropshipAdminNotificationOpsListItem[];
  total: number;
  page: number;
  limit: number;
  statuses: DropshipNotificationOpsStatus[];
  channels: DropshipNotificationOpsChannel[] | null;
  summary: Array<{ status: DropshipNotificationOpsStatus; count: number }>;
  channelSummary: Array<{ channel: DropshipNotificationOpsChannel; count: number }>;
}

export interface DropshipAdminTrackingPushRetryInput {
  idempotencyKey: string;
  reason?: string;
}

export interface DropshipAdminTrackingPushRetryResponse {
  pushId: number;
  previousStatus: DropshipTrackingPushStatus;
  status: "not_dropship" | "already_succeeded" | "succeeded";
  idempotentReplay: boolean;
  updatedPush: {
    pushId: number;
    intakeId: number;
    omsOrderId: number;
    wmsShipmentId: number | null;
    vendorId: number;
    storeConnectionId: number;
    platform: string;
    status: string;
    externalOrderId: string;
    trackingNumber: string;
    carrier: string;
    attemptCount: number;
    externalFulfillmentId: string | null;
  } | null;
}

export interface DropshipAdminOrderOpsActionInput {
  idempotencyKey: string;
  reason?: string;
}

export interface DropshipAdminOrderOpsActionResponse {
  intakeId: number;
  previousStatus: DropshipOpsOrderIntakeStatus;
  status: DropshipOpsOrderIntakeStatus;
  idempotentReplay: boolean;
  updatedAt: string;
}

export interface DropshipStoreConnectionProfileResponse {
  storeConnectionId: number;
  vendorId: number;
  platform: DropshipStorePlatform;
  externalAccountId: string | null;
  externalDisplayName: string | null;
  shopDomain: string | null;
  status: DropshipStoreConnectionLifecycleStatus;
  setupStatus: string;
  disconnectReason: string | null;
  disconnectedAt: string | null;
  graceEndsAt: string | null;
  tokenExpiresAt: string | null;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  lastSyncAt: string | null;
  lastOrderSyncAt: string | null;
  lastInventorySyncAt: string | null;
  orderProcessingConfig: {
    defaultWarehouseId: number | null;
  };
  createdAt: string;
  updatedAt: string;
}

export interface DropshipStoreListingConfigProfileResponse {
  id: number;
  storeConnectionId: number;
  platform: DropshipStorePlatform;
  listingMode: DropshipListingMode;
  inventoryMode: DropshipListingInventoryMode;
  priceMode: DropshipListingPriceMode;
  marketplaceConfig: Record<string, unknown>;
  requiredConfigKeys: string[];
  requiredProductFields: DropshipListingRequiredProductField[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DropshipStoreListingConfigSummary {
  isConfigured: boolean;
  isActive: boolean;
  listingMode: DropshipListingMode | null;
  inventoryMode: DropshipListingInventoryMode | null;
  priceMode: DropshipListingPriceMode | null;
  requiredConfigKeys: string[];
  requiredProductFields: DropshipListingRequiredProductField[];
  updatedAt: string | null;
}

export interface DropshipAdminStoreConnectionListItem extends DropshipStoreConnectionProfileResponse {
  vendor: {
    vendorId: number;
    memberId: string;
    businessName: string | null;
    email: string | null;
    status: string;
    entitlementStatus: string;
  };
  listingConfig: DropshipStoreListingConfigSummary;
  setupCheckSummary: {
    openCount: number;
    errorCount: number;
    warningCount: number;
  };
}

export interface DropshipAdminStoreConnectionListResponse {
  items: DropshipAdminStoreConnectionListItem[];
  total: number;
  page: number;
  limit: number;
}

export interface DropshipStoreOrderProcessingConfigInput {
  defaultWarehouseId: number | null;
  idempotencyKey: string;
}

export interface DropshipStoreOrderProcessingConfigResponse {
  connection: DropshipStoreConnectionProfileResponse;
}

export interface DropshipStoreListingConfigInput {
  listingMode: DropshipListingMode;
  inventoryMode: DropshipListingInventoryMode;
  priceMode: DropshipListingPriceMode;
  marketplaceConfig: Record<string, unknown>;
  requiredConfigKeys: string[];
  requiredProductFields: DropshipListingRequiredProductField[];
  isActive: boolean;
}

export interface DropshipStoreListingConfigResponse {
  storeConnection: {
    vendorId: number;
    storeConnectionId: number;
    platform: DropshipStorePlatform;
    status: DropshipStoreConnectionLifecycleStatus;
    setupStatus: string;
  };
  config: DropshipStoreListingConfigProfileResponse;
}

export interface DropshipAdminStoreWebhookRepairInput {
  idempotencyKey: string;
}

export interface DropshipAdminStoreWebhookRepairResponse {
  result: {
    storeConnectionId: number;
    vendorId: number;
    platform: "shopify";
    shopDomain: string;
    repairedAt: string;
  };
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

export interface DropshipListingPreviewRow {
  productVariantId: number;
  productId: number;
  sku: string | null;
  title: string;
  platform: string;
  listingMode: string | null;
  currentListingStatus: string;
  previewStatus: "ready" | "blocked" | "warning";
  blockers: string[];
  warnings: string[];
  marketplaceQuantity: number;
  priceCents: number | null;
  previewHash: string;
}

export interface DropshipListingPreviewResult {
  vendorId: number;
  storeConnectionId: number;
  platform: string;
  generatedAt: string;
  rows: DropshipListingPreviewRow[];
  summary: {
    total: number;
    ready: number;
    blocked: number;
    warning: number;
  };
}

export interface DropshipListingPreviewResponse {
  preview: DropshipListingPreviewResult;
}

export interface DropshipListingPushResponse {
  job: {
    jobId: number;
    vendorId: number;
    storeConnectionId: number;
    status: string;
    idempotencyKey: string | null;
    requestHash: string | null;
    createdAt: string;
    updatedAt: string;
  };
  items: Array<{
    itemId: number;
    jobId: number;
    listingId: number | null;
    productVariantId: number;
    status: string;
    previewHash: string | null;
    errorCode: string | null;
    errorMessage: string | null;
  }>;
  preview: DropshipListingPreviewResult;
  idempotentReplay: boolean;
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
    address1?: string;
    address2?: string;
    city?: string;
    region?: string;
    postalCode?: string;
    country?: string;
    phone?: string;
    email?: string;
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

export interface DropshipOrderDetailLine {
  lineIndex: number;
  externalLineItemId: string | null;
  externalListingId: string | null;
  externalOfferId: string | null;
  sku: string | null;
  productVariantId: number | null;
  quantity: number;
  unitRetailPriceCents: number | null;
  lineRetailTotalCents: number | null;
  title: string | null;
}

export interface DropshipOrderDetailTotals {
  retailSubtotalCents: number | null;
  shippingPaidCents: number | null;
  taxCents: number | null;
  discountCents: number | null;
  grandTotalCents: number | null;
  currency: string;
}

export interface DropshipOrderEconomicsSnapshot {
  economicsSnapshotId: number;
  shippingQuoteSnapshotId: number | null;
  warehouseId: number | null;
  currency: string;
  retailSubtotalCents: number;
  wholesaleSubtotalCents: number;
  shippingCents: number;
  insurancePoolCents: number;
  feesCents: number;
  totalDebitCents: number;
  pricingSnapshot: Record<string, unknown>;
  createdAt: string;
}

export interface DropshipOrderShippingQuoteSnapshot {
  quoteSnapshotId: number;
  warehouseId: number;
  currency: string;
  destinationCountry: string;
  destinationPostalCode: string | null;
  packageCount: number;
  baseRateCents: number;
  markupCents: number;
  insurancePoolCents: number;
  dunnageCents: number;
  totalShippingCents: number;
  quotePayload: Record<string, unknown>;
  createdAt: string;
}

export interface DropshipOrderWalletLedgerEntry {
  walletLedgerEntryId: number;
  type: string;
  status: string;
  amountCents: number;
  currency: string;
  availableBalanceAfterCents: number | null;
  pendingBalanceAfterCents: number | null;
  createdAt: string;
  settledAt: string | null;
}

export interface DropshipOrderAuditEventDetail {
  eventType: string;
  actorType: string;
  actorId: string | null;
  severity: DropshipSeverity;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface DropshipOrderTrackingPushSummary {
  pushId: number;
  wmsShipmentId: number | null;
  platform: string;
  status: DropshipTrackingPushStatus;
  carrier: string;
  trackingNumber: string;
  shippedAt: string;
  externalFulfillmentId: string | null;
  attemptCount: number;
  retryable: boolean;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface DropshipOrderDetail extends DropshipOrderListItem {
  sourceOrderId: string | null;
  orderedAt: string | null;
  marketplaceStatus: string | null;
  totals: DropshipOrderDetailTotals | null;
  lines: DropshipOrderDetailLine[];
  economicsSnapshot: DropshipOrderEconomicsSnapshot | null;
  shippingQuoteSnapshot: DropshipOrderShippingQuoteSnapshot | null;
  walletLedgerEntry: DropshipOrderWalletLedgerEntry | null;
  trackingPushes: DropshipOrderTrackingPushSummary[];
  auditEvents: DropshipOrderAuditEventDetail[];
}

export interface DropshipOrderListResponse {
  items: DropshipOrderListItem[];
  total: number;
  page: number;
  limit: number;
  statuses: string[];
  summary: Array<{ status: string; count: number }>;
}

export interface DropshipOrderDetailResponse {
  order: DropshipOrderDetail;
}

export interface DropshipOrderAcceptInput {
  idempotencyKey: string;
}

export interface DropshipOrderAcceptResponse {
  result: {
    outcome: "accepted" | "payment_hold";
    intakeId: number;
    vendorId: number;
    storeConnectionId: number;
    shippingQuoteSnapshotId: number;
    omsOrderId: number | null;
    walletLedgerEntryId: number | null;
    economicsSnapshotId: number | null;
    totalDebitCents: number;
    currency: string;
    paymentHoldExpiresAt: string | null;
    idempotentReplay: boolean;
    quote: {
      quoteSnapshotId: number;
      idempotentReplay: boolean;
      warehouseId: number;
      packageCount: number;
      totalShippingCents: number;
      currency: string;
      carrierServices: Array<{ carrier: string; service: string }>;
    };
  };
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

export interface DropshipAutoReloadConfigInput {
  fundingMethodId: number | null;
  enabled: boolean;
  minimumBalanceCents: number;
  maxSingleReloadCents: number | null;
  paymentHoldTimeoutMinutes: number;
}

export interface DropshipAutoReloadConfigResponse {
  autoReload: NonNullable<DropshipWalletResponse["wallet"]["autoReload"]>;
}

export type DropshipStripeFundingRail = "stripe_card" | "stripe_ach";

export interface DropshipStripeFundingSetupSessionInput {
  rail: DropshipStripeFundingRail;
  returnTo: string;
}

export interface DropshipStripeFundingSetupSessionResponse {
  setupSession: {
    checkoutUrl: string;
    providerSessionId: string;
    expiresAt: string | null;
  };
}

export interface DropshipStripeWalletFundingSessionInput {
  fundingMethodId: number;
  amountCents: number;
  returnTo: string;
}

export interface DropshipStripeWalletFundingSessionResponse {
  fundingSession: {
    checkoutUrl: string;
    providerSessionId: string;
    amountCents: number;
    currency: string;
    expiresAt: string | null;
  };
}

export interface DropshipReturnListItem {
  rmaId: number;
  rmaNumber: string;
  vendorId: number;
  vendorName: string | null;
  vendorEmail: string | null;
  status: DropshipRmaStatus;
  reasonCode: string | null;
  faultCategory: DropshipReturnFaultCategory | null;
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

export interface DropshipAdminReturnStatusUpdateInput {
  status: DropshipRmaStatus;
  notes?: string;
  idempotencyKey: string;
}

export interface DropshipAdminReturnStatusUpdateResponse {
  rma: DropshipReturnListItem & {
    labelSource: string | null;
    vendorNotes: string | null;
    idempotencyKey: string | null;
    requestHash: string | null;
    items: Array<{
      rmaItemId: number;
      rmaId: number;
      productVariantId: number | null;
      quantity: number;
      status: string;
      requestedCreditCents: number | null;
      finalCreditCents: number | null;
      feeCents: number | null;
      createdAt: string;
    }>;
    inspections: Array<{
      rmaInspectionId: number;
      rmaId: number;
      outcome: "approved" | "rejected";
      faultCategory: DropshipReturnFaultCategory | null;
      notes: string | null;
      photos: Record<string, unknown>[];
      creditCents: number;
      feeCents: number;
      inspectedBy: string | null;
      idempotencyKey: string | null;
      requestHash: string | null;
      createdAt: string;
    }>;
    walletLedger: Array<Record<string, unknown>>;
  };
  idempotentReplay: boolean;
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

export function queryErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

export function buildAdminCatalogExposurePreviewUrl(input: {
  search: string;
  exposedOnly: boolean;
  includeInactiveCatalog: boolean;
  page?: number;
  limit?: number;
}): string {
  return buildQueryUrl("/api/dropship/admin/catalog/preview", {
    search: input.search.trim(),
    exposedOnly: input.exposedOnly,
    includeInactiveCatalog: input.includeInactiveCatalog,
    page: input.page ?? 1,
    limit: input.limit ?? 50,
  });
}

export function buildAdminOrderIntakeUrl(input: {
  search: string;
  status: DropshipOpsOrderIntakeStatus | "default" | "all";
  page?: number;
  limit?: number;
}): string {
  const statuses = input.status === "default"
    ? undefined
    : input.status === "all"
      ? allDropshipOpsOrderIntakeStatuses.join(",")
      : input.status;
  return buildQueryUrl("/api/dropship/admin/order-intake", {
    search: input.search.trim(),
    statuses,
    page: input.page ?? 1,
    limit: input.limit ?? 50,
  });
}

export function buildAdminListingPushJobsUrl(input: {
  search: string;
  status: DropshipListingPushJobStatus | "default" | "all";
  platform: DropshipStorePlatform | "all";
  page?: number;
  limit?: number;
}): string {
  const statuses = input.status === "default"
    ? undefined
    : input.status === "all"
      ? allDropshipListingPushJobStatuses.join(",")
      : input.status;
  return buildQueryUrl("/api/dropship/admin/listing-push-jobs", {
    search: input.search.trim(),
    statuses,
    platform: input.platform === "all" ? undefined : input.platform,
    page: input.page ?? 1,
    limit: input.limit ?? 50,
  });
}

export function buildAdminTrackingPushesUrl(input: {
  search: string;
  status: DropshipTrackingPushStatus | "default" | "all";
  platform: DropshipStorePlatform | "all";
  page?: number;
  limit?: number;
}): string {
  const statuses = input.status === "default"
    ? undefined
    : input.status === "all"
      ? allDropshipTrackingPushStatuses.join(",")
      : input.status;
  return buildQueryUrl("/api/dropship/admin/tracking-pushes", {
    search: input.search.trim(),
    statuses,
    platform: input.platform === "all" ? undefined : input.platform,
    page: input.page ?? 1,
    limit: input.limit ?? 50,
  });
}

export function buildAdminNotificationEventsUrl(input: {
  search: string;
  status: DropshipNotificationOpsStatus | "default" | "all";
  channel: DropshipNotificationOpsChannel | "all";
  critical: "all" | "critical" | "noncritical";
  page?: number;
  limit?: number;
}): string {
  const statuses = input.status === "default"
    ? undefined
    : input.status === "all"
      ? allDropshipNotificationOpsStatuses.join(",")
      : input.status;
  const critical = input.critical === "all"
    ? undefined
    : input.critical === "critical";
  return buildQueryUrl("/api/dropship/admin/notifications", {
    search: input.search.trim(),
    statuses,
    channel: input.channel === "all" ? undefined : input.channel,
    critical,
    page: input.page ?? 1,
    limit: input.limit ?? 50,
  });
}

export function buildAdminReturnsUrl(input: {
  search: string;
  status: DropshipRmaStatus | "default" | "all";
  page?: number;
  limit?: number;
}): string {
  const statuses = input.status === "default"
    ? defaultDropshipRmaOpsStatuses.join(",")
    : input.status === "all"
      ? allDropshipRmaStatuses.join(",")
      : input.status;
  return buildQueryUrl("/api/dropship/admin/returns", {
    search: input.search.trim(),
    statuses,
    page: input.page ?? 1,
    limit: input.limit ?? 50,
  });
}

export function buildAdminDogfoodReadinessUrl(input: {
  search: string;
  status: DropshipDogfoodReadinessStatus | "all";
  platform: DropshipStorePlatform | "all";
  page?: number;
  limit?: number;
}): string {
  return buildQueryUrl("/api/dropship/admin/dogfood-readiness", {
    search: input.search.trim(),
    status: input.status === "all" ? undefined : input.status,
    platform: input.platform === "all" ? undefined : input.platform,
    page: input.page ?? 1,
    limit: input.limit ?? 50,
  });
}

export function buildAdminOmsChannelConfigUrl(): string {
  return "/api/dropship/admin/oms-channel-config";
}

export function buildAdminOmsChannelConfigureInput(input: {
  channelId: string | number;
  idempotencyKey: string;
}): DropshipAdminOmsChannelConfigureInput {
  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    throw new Error("idempotencyKey must be between 8 and 200 characters.");
  }

  return {
    channelId: parsePositiveIntegerInput(input.channelId, "channelId"),
    idempotencyKey,
  };
}

export function buildAdminShippingConfigUrl(input: {
  search?: string;
  packageProfileLimit?: number;
  rateTableLimit?: number;
} = {}): string {
  return buildQueryUrl("/api/dropship/admin/shipping/config", {
    search: input.search?.trim() || undefined,
    packageProfileLimit: input.packageProfileLimit ?? 50,
    rateTableLimit: input.rateTableLimit ?? 25,
  });
}

export function buildAdminStoreConnectionsUrl(input: {
  search: string;
  status: DropshipStoreConnectionLifecycleStatus | "all";
  platform: DropshipStorePlatform | "all";
  page?: number;
  limit?: number;
}): string {
  return buildQueryUrl("/api/dropship/admin/store-connections", {
    search: input.search.trim(),
    statuses: input.status === "all" ? undefined : input.status,
    platform: input.platform === "all" ? undefined : input.platform,
    page: input.page ?? 1,
    limit: input.limit ?? 50,
  });
}

export function buildStoreOrderProcessingConfigInput(input: {
  defaultWarehouseId: string;
  idempotencyKey: string;
}): DropshipStoreOrderProcessingConfigInput {
  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    throw new Error("idempotencyKey must be between 8 and 200 characters.");
  }

  return {
    idempotencyKey,
    defaultWarehouseId: input.defaultWarehouseId.trim()
      ? parsePositiveInteger(input.defaultWarehouseId, "defaultWarehouseId")
      : null,
  };
}

export function buildStoreListingConfigInput(input: {
  listingMode: DropshipListingMode;
  inventoryMode: DropshipListingInventoryMode;
  priceMode: DropshipListingPriceMode;
  marketplaceConfigJson: string;
  requiredConfigKeys: string;
  requiredProductFields: string;
  isActive: boolean;
}): DropshipStoreListingConfigInput {
  if (!allDropshipListingModes.includes(input.listingMode)) {
    throw new Error("listingMode is not supported.");
  }
  if (!allDropshipListingInventoryModes.includes(input.inventoryMode)) {
    throw new Error("inventoryMode is not supported.");
  }
  if (!allDropshipListingPriceModes.includes(input.priceMode)) {
    throw new Error("priceMode is not supported.");
  }

  return {
    listingMode: input.listingMode,
    inventoryMode: input.inventoryMode,
    priceMode: input.priceMode,
    marketplaceConfig: parseJsonObject(input.marketplaceConfigJson, "marketplaceConfig"),
    requiredConfigKeys: parseRequiredConfigKeys(input.requiredConfigKeys),
    requiredProductFields: parseRequiredProductFields(input.requiredProductFields),
    isActive: input.isActive,
  };
}

export function buildAdminStoreWebhookRepairInput(input: {
  idempotencyKey: string;
}): DropshipAdminStoreWebhookRepairInput {
  return {
    idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey),
  };
}

export function buildAdminOrderOpsActionInput(input: {
  idempotencyKey: string;
  reason: string;
  requireReason: boolean;
}): DropshipAdminOrderOpsActionInput {
  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    throw new Error("idempotencyKey must be between 8 and 200 characters.");
  }

  const reason = input.reason.trim();
  if (input.requireReason && !reason) {
    throw new Error("Reason is required.");
  }
  if (reason.length > 1000) {
    throw new Error("Reason must be 1000 characters or fewer.");
  }

  return reason ? { idempotencyKey, reason } : { idempotencyKey };
}

export function buildAdminTrackingPushRetryInput(input: {
  idempotencyKey: string;
  reason: string;
}): DropshipAdminTrackingPushRetryInput {
  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    throw new Error("idempotencyKey must be between 8 and 200 characters.");
  }

  const reason = input.reason.trim();
  if (reason.length > 1000) {
    throw new Error("Reason must be 1000 characters or fewer.");
  }

  return reason ? { idempotencyKey, reason } : { idempotencyKey };
}

export function buildAdminReturnStatusUpdateInput(input: {
  idempotencyKey: string;
  status: DropshipRmaStatus;
  notes: string;
}): DropshipAdminReturnStatusUpdateInput {
  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    throw new Error("idempotencyKey must be between 8 and 200 characters.");
  }

  const notes = input.notes.trim();
  if (notes.length > 5000) {
    throw new Error("Notes must be 5000 characters or fewer.");
  }

  return notes
    ? { idempotencyKey, status: input.status, notes }
    : { idempotencyKey, status: input.status };
}

export function buildShippingBoxInput(input: {
  boxId?: string;
  code: string;
  name: string;
  lengthMm: string;
  widthMm: string;
  heightMm: string;
  tareWeightGrams: string;
  maxWeightGrams: string;
  isActive: boolean;
  idempotencyKey: string;
}): DropshipShippingBoxInput {
  return {
    boxId: input.boxId?.trim() ? parsePositiveInteger(input.boxId, "boxId") : undefined,
    code: requiredTrimmedString(input.code, "code", 80),
    name: requiredTrimmedString(input.name, "name", 200),
    lengthMm: parsePositiveInteger(input.lengthMm, "lengthMm"),
    widthMm: parsePositiveInteger(input.widthMm, "widthMm"),
    heightMm: parsePositiveInteger(input.heightMm, "heightMm"),
    tareWeightGrams: parseNonNegativeInteger(input.tareWeightGrams, "tareWeightGrams"),
    maxWeightGrams: input.maxWeightGrams.trim() ? parsePositiveInteger(input.maxWeightGrams, "maxWeightGrams") : null,
    isActive: input.isActive,
    idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey),
  };
}

export function buildShippingPackageProfileInput(input: {
  productVariantId: string;
  weightGrams: string;
  lengthMm: string;
  widthMm: string;
  heightMm: string;
  shipAlone: boolean;
  defaultCarrier: string;
  defaultService: string;
  defaultBoxId: string;
  maxUnitsPerPackage: string;
  isActive: boolean;
  idempotencyKey: string;
}): DropshipShippingPackageProfileInput {
  return {
    productVariantId: parsePositiveInteger(input.productVariantId, "productVariantId"),
    weightGrams: parsePositiveInteger(input.weightGrams, "weightGrams"),
    lengthMm: parsePositiveInteger(input.lengthMm, "lengthMm"),
    widthMm: parsePositiveInteger(input.widthMm, "widthMm"),
    heightMm: parsePositiveInteger(input.heightMm, "heightMm"),
    shipAlone: input.shipAlone,
    defaultCarrier: input.defaultCarrier.trim() || null,
    defaultService: input.defaultService.trim() || null,
    defaultBoxId: input.defaultBoxId.trim() ? parsePositiveInteger(input.defaultBoxId, "defaultBoxId") : null,
    maxUnitsPerPackage: input.maxUnitsPerPackage.trim()
      ? parsePositiveInteger(input.maxUnitsPerPackage, "maxUnitsPerPackage")
      : null,
    isActive: input.isActive,
    idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey),
  };
}

export function buildShippingZoneRuleInput(input: {
  zoneRuleId?: string;
  originWarehouseId: string;
  destinationCountry: string;
  destinationRegion: string;
  postalPrefix: string;
  zone: string;
  priority: string;
  isActive: boolean;
  idempotencyKey: string;
}): DropshipShippingZoneRuleInput {
  return {
    zoneRuleId: input.zoneRuleId?.trim() ? parsePositiveInteger(input.zoneRuleId, "zoneRuleId") : undefined,
    originWarehouseId: parsePositiveInteger(input.originWarehouseId, "originWarehouseId"),
    destinationCountry: requiredTrimmedString(input.destinationCountry, "destinationCountry", 2).toUpperCase(),
    destinationRegion: input.destinationRegion.trim() || null,
    postalPrefix: input.postalPrefix.trim() || null,
    zone: requiredTrimmedString(input.zone, "zone", 40),
    priority: parseIntegerInput(input.priority, "priority"),
    isActive: input.isActive,
    idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey),
  };
}

export function buildShippingRateTableInput(input: {
  carrier: string;
  service: string;
  currency: string;
  status: "draft" | "active" | "archived";
  effectiveFrom: string;
  effectiveTo: string;
  warehouseId: string;
  destinationZone: string;
  minWeightGrams: string;
  maxWeightGrams: string;
  rate: string;
  idempotencyKey: string;
}): DropshipShippingRateTableInput {
  const minWeightGrams = parseNonNegativeInteger(input.minWeightGrams, "minWeightGrams");
  const maxWeightGrams = parsePositiveInteger(input.maxWeightGrams, "maxWeightGrams");
  if (maxWeightGrams < minWeightGrams) {
    throw new Error("maxWeightGrams must be greater than or equal to minWeightGrams.");
  }

  return {
    carrier: requiredTrimmedString(input.carrier, "carrier", 50),
    service: requiredTrimmedString(input.service, "service", 80),
    currency: requiredTrimmedString(input.currency, "currency", 3).toUpperCase(),
    status: input.status,
    effectiveFrom: input.effectiveFrom.trim() || undefined,
    effectiveTo: input.effectiveTo.trim() || null,
    rows: [{
      warehouseId: input.warehouseId.trim() ? parsePositiveInteger(input.warehouseId, "warehouseId") : null,
      destinationZone: requiredTrimmedString(input.destinationZone, "destinationZone", 40),
      minWeightGrams,
      maxWeightGrams,
      rateCents: parseDollarInputToCents(input.rate, "rate"),
    }],
    metadata: {},
    idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey),
  };
}

export function buildShippingMarkupPolicyInput(input: {
  name: string;
  markupBps: string;
  fixedMarkup: string;
  minMarkup: string;
  maxMarkup: string;
  isActive: boolean;
  effectiveFrom: string;
  effectiveTo: string;
  idempotencyKey: string;
}): DropshipShippingMarkupPolicyInput {
  return {
    name: requiredTrimmedString(input.name, "name", 120),
    markupBps: parseBasisPoints(input.markupBps, "markupBps"),
    fixedMarkupCents: parseDollarInputToCents(input.fixedMarkup || "0", "fixedMarkup"),
    minMarkupCents: input.minMarkup.trim() ? parseDollarInputToCents(input.minMarkup, "minMarkup") : null,
    maxMarkupCents: input.maxMarkup.trim() ? parseDollarInputToCents(input.maxMarkup, "maxMarkup") : null,
    isActive: input.isActive,
    effectiveFrom: input.effectiveFrom.trim() || undefined,
    effectiveTo: input.effectiveTo.trim() || null,
    idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey),
  };
}

export function buildShippingInsurancePolicyInput(input: {
  name: string;
  feeBps: string;
  minFee: string;
  maxFee: string;
  isActive: boolean;
  effectiveFrom: string;
  effectiveTo: string;
  idempotencyKey: string;
}): DropshipShippingInsurancePolicyInput {
  return {
    name: requiredTrimmedString(input.name, "name", 120),
    feeBps: parseBasisPoints(input.feeBps, "feeBps"),
    minFeeCents: input.minFee.trim() ? parseDollarInputToCents(input.minFee, "minFee") : null,
    maxFeeCents: input.maxFee.trim() ? parseDollarInputToCents(input.maxFee, "maxFee") : null,
    isActive: input.isActive,
    effectiveFrom: input.effectiveFrom.trim() || undefined,
    effectiveTo: input.effectiveTo.trim() || null,
    idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey),
  };
}

export function buildCatalogExposureRuleInput(input: {
  scopeType: DropshipCatalogExposureScope;
  action: DropshipCatalogExposureAction;
  productLineId?: string | number | null;
  productId?: string | number | null;
  productVariantId?: string | number | null;
  category?: string | null;
  priority?: string | number | null;
  notes?: string | null;
  metadata?: Record<string, unknown>;
}): DropshipAdminCatalogExposureRuleInput {
  const priority = input.priority === undefined || input.priority === null || input.priority === ""
    ? 0
    : parseIntegerInput(input.priority, "priority");
  const rule: DropshipAdminCatalogExposureRuleInput = {
    scopeType: input.scopeType,
    action: input.action,
    productLineId: null,
    productId: null,
    productVariantId: null,
    category: null,
    priority,
    startsAt: null,
    endsAt: null,
    notes: input.notes?.trim() || null,
    metadata: input.metadata ?? {},
  };

  if (input.scopeType === "product_line") {
    rule.productLineId = parsePositiveIntegerInput(input.productLineId, "productLineId");
  } else if (input.scopeType === "product") {
    rule.productId = parsePositiveIntegerInput(input.productId, "productId");
  } else if (input.scopeType === "variant") {
    rule.productVariantId = parsePositiveIntegerInput(input.productVariantId, "productVariantId");
  } else if (input.scopeType === "category") {
    const category = input.category?.trim();
    if (!category) {
      throw new Error("category is required for category exposure rules.");
    }
    rule.category = category;
  }

  return rule;
}

export function catalogExposureRecordToInput(
  rule: DropshipAdminCatalogExposureRule,
): DropshipAdminCatalogExposureRuleInput {
  return {
    scopeType: rule.scopeType,
    action: rule.action,
    productLineId: rule.productLineId ?? null,
    productId: rule.productId ?? null,
    productVariantId: rule.productVariantId ?? null,
    category: rule.category?.trim() || null,
    priority: rule.priority,
    startsAt: rule.startsAt ?? null,
    endsAt: rule.endsAt ?? null,
    notes: rule.notes?.trim() || null,
    metadata: rule.metadata ?? {},
  };
}

export function catalogExposureRuleKey(rule: Pick<
  DropshipAdminCatalogExposureRuleInput,
  "scopeType" | "action" | "productLineId" | "productId" | "productVariantId" | "category"
>): string {
  return [
    rule.scopeType,
    rule.action,
    rule.productLineId ?? "",
    rule.productId ?? "",
    rule.productVariantId ?? "",
    rule.category?.trim().toLowerCase() ?? "",
  ].join(":");
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

export function buildDropshipOrderAcceptInput(input: {
  idempotencyKey: string;
}): DropshipOrderAcceptInput {
  return {
    idempotencyKey: normalizeIdempotencyKey(input.idempotencyKey),
  };
}

export function buildListingPreviewRequest(input: {
  storeConnectionId: number;
  rows: readonly DropshipCatalogRow[];
}): { storeConnectionId: number; productVariantIds: number[] } {
  return {
    storeConnectionId: assertPositiveInteger(input.storeConnectionId, "storeConnectionId"),
    productVariantIds: uniqueSelectedVariantIds(input.rows),
  };
}

export function buildListingPushRequest(input: {
  storeConnectionId: number;
  preview: DropshipListingPreviewResult;
  idempotencyKey: string;
}): { storeConnectionId: number; productVariantIds: number[]; idempotencyKey: string } {
  return {
    storeConnectionId: assertPositiveInteger(input.storeConnectionId, "storeConnectionId"),
    productVariantIds: input.preview.rows
      .filter((row) => row.previewStatus !== "blocked")
      .map((row) => row.productVariantId),
    idempotencyKey: input.idempotencyKey,
  };
}

export function listingPreviewPushableCount(preview: DropshipListingPreviewResult | null | undefined): number {
  return preview?.rows.filter((row) => row.previewStatus !== "blocked").length ?? 0;
}

export function buildAutoReloadConfigInput(input: {
  enabled: boolean;
  fundingMethodId: string;
  minimumBalance: string;
  maxSingleReload: string;
  paymentHoldTimeoutMinutes: string;
}): DropshipAutoReloadConfigInput {
  const fundingMethodId = input.fundingMethodId.trim() ? parsePositiveInteger(input.fundingMethodId, "fundingMethodId") : null;
  const minimumBalanceCents = parseDollarInputToCents(input.minimumBalance, "minimumBalance");
  const maxSingleReloadCents = input.maxSingleReload.trim()
    ? parseDollarInputToCents(input.maxSingleReload, "maxSingleReload")
    : null;
  const paymentHoldTimeoutMinutes = parsePositiveInteger(input.paymentHoldTimeoutMinutes, "paymentHoldTimeoutMinutes");

  if (input.enabled && !fundingMethodId) {
    throw new Error("Select an active funding method before enabling auto-reload.");
  }
  if (input.enabled && minimumBalanceCents <= 0) {
    throw new Error("Minimum balance must be greater than $0.00 when auto-reload is enabled.");
  }
  if (input.enabled && maxSingleReloadCents !== null && maxSingleReloadCents < minimumBalanceCents) {
    throw new Error("Maximum single reload must be at least the minimum balance.");
  }

  return {
    enabled: input.enabled,
    fundingMethodId,
    minimumBalanceCents,
    maxSingleReloadCents,
    paymentHoldTimeoutMinutes,
  };
}

export function buildStripeFundingSetupSessionInput(input: {
  rail: string;
  returnTo: string;
}): DropshipStripeFundingSetupSessionInput {
  if (input.rail !== "stripe_card" && input.rail !== "stripe_ach") {
    throw new Error("Funding rail must be card or ACH.");
  }
  return {
    rail: input.rail,
    returnTo: normalizePortalReturnPath(input.returnTo),
  };
}

export function buildStripeWalletFundingSessionInput(input: {
  fundingMethodId: string;
  amount: string;
  returnTo: string;
}): DropshipStripeWalletFundingSessionInput {
  const fundingMethodId = parsePositiveInteger(input.fundingMethodId, "fundingMethodId");
  const amountCents = parseDollarInputToCents(input.amount, "fundingAmount");
  if (amountCents <= 0) {
    throw new Error("Funding amount must be greater than $0.00.");
  }
  return {
    fundingMethodId,
    amountCents,
    returnTo: normalizePortalReturnPath(input.returnTo),
  };
}

export function parseDollarInputToCents(value: string, field: string): number {
  const normalized = value.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
    throw new Error(`${field} must be a non-negative dollar amount with no more than two decimal places.`);
  }

  const [dollars, cents = ""] = normalized.split(".");
  const dollarCents = Number(dollars) * 100;
  const centValue = Number(cents.padEnd(2, "0"));
  const result = dollarCents + centValue;
  if (!Number.isSafeInteger(result)) {
    throw new Error(`${field} is outside the supported currency range.`);
  }
  return result;
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

function uniqueSelectedVariantIds(rows: readonly DropshipCatalogRow[]): number[] {
  return Array.from(uniquePositiveVariantIds(rows.filter((row) => row.selectionDecision.selected)));
}

function assertPositiveInteger(value: number, key: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer.`);
  }
  return value;
}

function parsePositiveInteger(value: string, key: string): number {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${key} must be a positive integer.`);
  }
  const parsed = Number(normalized);
  return assertPositiveInteger(parsed, key);
}

function parseNonNegativeInteger(value: string, key: string): number {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${key} must be a non-negative integer.`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${key} is outside the supported integer range.`);
  }
  return parsed;
}

function parseBasisPoints(value: string, key: string): number {
  const parsed = parseNonNegativeInteger(value, key);
  if (parsed > 10000) {
    throw new Error(`${key} must be 10000 or fewer.`);
  }
  return parsed;
}

function normalizeIdempotencyKey(value: string): string {
  const idempotencyKey = value.trim();
  if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    throw new Error("idempotencyKey must be between 8 and 200 characters.");
  }
  return idempotencyKey;
}

function requiredTrimmedString(value: string, key: string, maxLength: number): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${key} is required.`);
  }
  if (trimmed.length > maxLength) {
    throw new Error(`${key} must be ${maxLength} characters or fewer.`);
  }
  return trimmed;
}

function parsePositiveIntegerInput(value: string | number | null | undefined, key: string): number {
  if (typeof value === "number") {
    return assertPositiveInteger(value, key);
  }
  if (typeof value === "string") {
    return parsePositiveInteger(value, key);
  }
  throw new Error(`${key} must be a positive integer.`);
}

function parseIntegerInput(value: string | number, key: string): number {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error(`${key} must be an integer.`);
    }
    return value;
  }
  const normalized = value.trim();
  if (!/^-?\d+$/.test(normalized)) {
    throw new Error(`${key} must be an integer.`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${key} is outside the supported integer range.`);
  }
  return parsed;
}

function parseJsonObject(value: string, key: string): Record<string, unknown> {
  const trimmed = value.trim();
  if (!trimmed) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`${key} must be valid JSON.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${key} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function parseRequiredConfigKeys(value: string): string[] {
  const keys = uniqueCsvTokens(value);
  if (keys.length > 100) {
    throw new Error("requiredConfigKeys must include 100 or fewer keys.");
  }
  for (const key of keys) {
    if (!/^[A-Za-z0-9_.-]+$/.test(key) || key.length > 120) {
      throw new Error("Required config keys may only contain letters, numbers, dots, underscores, and hyphens.");
    }
  }
  return keys;
}

function parseRequiredProductFields(value: string): DropshipListingRequiredProductField[] {
  const fields = uniqueCsvTokens(value);
  if (fields.length > 25) {
    throw new Error("requiredProductFields must include 25 or fewer fields.");
  }
  for (const field of fields) {
    if (!allDropshipListingRequiredProductFields.includes(field as DropshipListingRequiredProductField)) {
      throw new Error(`${field} is not a supported required product field.`);
    }
  }
  return fields as DropshipListingRequiredProductField[];
}

function uniqueCsvTokens(value: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const rawToken of value.split(",")) {
    const token = rawToken.trim();
    if (!token || seen.has(token)) {
      continue;
    }
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
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
    if (typeof body?.error === "string" && body.error.trim()) {
      return body.error;
    }
    if (typeof body?.error?.message === "string") {
      return body.error.message;
    }
    if (typeof body?.message === "string" && body.message.trim()) {
      return body.message;
    }
  } catch {
    // Fall through to status text.
  }
  return response.statusText || `Request failed with ${response.status}`;
}
