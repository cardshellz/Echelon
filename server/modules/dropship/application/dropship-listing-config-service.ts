import { isDeepStrictEqual } from "node:util";
import type { DropshipSourcePlatform, DropshipStoreConnectionStatus } from "../../../../shared/schema/dropship.schema";
import { DropshipError } from "../domain/errors";
import type { DropshipClock, DropshipLogEvent, DropshipLogger } from "./dropship-ports";
import type {
  DropshipListingInventoryMode,
  DropshipListingMode,
  DropshipListingPriceMode,
  DropshipStoreListingConfig,
} from "./dropship-marketplace-listing-provider";
import {
  replaceDropshipStoreListingConfigRequestSchema,
  type ReplaceDropshipStoreListingConfigInput,
} from "./dropship-listing-config-dtos";
import type {
  DropshipProvisionedVendorProfile,
  DropshipVendorProvisioningService,
} from "./dropship-vendor-provisioning-service";

export const DROPSHIP_DEFAULT_LISTING_MODE: DropshipListingMode = "draft_first";
export const DROPSHIP_DEFAULT_EBAY_LISTING_MODE: DropshipListingMode = "live";
export const DROPSHIP_DEFAULT_LISTING_INVENTORY_MODE: DropshipListingInventoryMode = "managed_quantity_sync";
export const DROPSHIP_DEFAULT_LISTING_PRICE_MODE: DropshipListingPriceMode = "vendor_defined";
/** Dropship eBay selling is currently registered and operated against the US marketplace. */
export const DROPSHIP_DEFAULT_EBAY_MARKETPLACE_ID = "EBAY_US";

export interface DropshipListingConfigStoreConnectionContext {
  vendorId: number;
  storeConnectionId: number;
  platform: DropshipSourcePlatform;
  status: DropshipStoreConnectionStatus;
  setupStatus: string;
}

export interface DropshipListingConfigActor {
  actorType: "vendor" | "admin" | "system";
  actorId: string | null;
}

export interface DropshipStoreListingConfigRecord extends DropshipStoreListingConfig {
  /**
   * Compare-and-set version (migration 0728). The database owns it: 1 on
   * insert, +1 on every update that changes the config. A writer sends the
   * revision it read and is refused when the config has moved since.
   */
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Keyed (idempotent) listing-config writes, as recorded in dropship_listing_config_requests (migration 0728). */
export type DropshipListingConfigRequestOperation = "ebay_listing_setup_save" | "ebay_ship_from_repair";

export interface DropshipListingConfigKeyedRequest {
  operation: DropshipListingConfigRequestOperation;
  idempotencyKey: string;
  /** sha256 hex of the operation, the store and the normalized request, including its expected revision. */
  requestHash: string;
}

export interface DropshipListingConfigKeyedRequestRecord {
  storeConnectionId: number;
  operation: DropshipListingConfigRequestOperation;
  requestHash: string;
  revisionBefore: number;
  revisionAfter: number;
  outcome: "changed" | "unchanged";
  createdAt: Date;
}

export type DropshipListingConfigAuditEventType =
  | "listing_config_replaced"
  | "listing_config_ship_from_repaired";

export interface ReplaceDropshipStoreListingConfigRepositoryInput {
  vendorId: number;
  storeConnectionId: number;
  platform: DropshipSourcePlatform;
  config: NormalizedDropshipStoreListingConfigInput;
  /** The revision the writer read; the write is refused unless the stored row is still at it. */
  expectedRevision: number;
  /** Store statuses this write may land on, re-checked under the store's row lock. */
  allowedStoreStatuses: readonly DropshipStoreConnectionStatus[];
  /** Present for keyed writes: replayed from the ledger instead of applied twice. */
  request: DropshipListingConfigKeyedRequest | null;
  auditEventType: DropshipListingConfigAuditEventType;
  actor: DropshipListingConfigActor;
  now: Date;
}

export type DropshipListingConfigWriteOutcome = "changed" | "unchanged" | "replayed";

export interface ReplaceDropshipStoreListingConfigRepositoryResult {
  /** The stored config after the write (the current one for a replay). */
  config: DropshipStoreListingConfigRecord;
  /**
   * changed: the config was updated and audited. unchanged: it already said
   * this, so nothing was written. replayed: this request key was applied
   * before; nothing was written now.
   */
  outcome: DropshipListingConfigWriteOutcome;
  /** The revision this request was made against (for a replay, as the ledger recorded it). */
  revisionBefore: number;
  /**
   * The revision this request left the config at (for a replay, as the ledger
   * recorded it). The config above can be newer when another write followed.
   */
  revisionAfter: number;
}

export interface EnsureDropshipStoreListingConfigRepositoryInput {
  vendorId: number;
  storeConnectionId: number;
  platform: DropshipSourcePlatform;
  actor: DropshipListingConfigActor;
  now: Date;
}

export interface DropshipListingConfigRepository {
  loadStoreConnectionContext(input: {
    vendorId: number;
    storeConnectionId: number;
  }): Promise<DropshipListingConfigStoreConnectionContext | null>;
  loadStoreConnectionContextById(input: {
    storeConnectionId: number;
  }): Promise<DropshipListingConfigStoreConnectionContext | null>;
  ensureDefaultConfig(
    input: EnsureDropshipStoreListingConfigRepositoryInput,
  ): Promise<DropshipStoreListingConfigRecord>;
  /** Read-only: the stored config, or null when the store has none yet. Never creates one. */
  findConfig(input: { storeConnectionId: number }): Promise<DropshipStoreListingConfigRecord | null>;
  findKeyedRequest(input: {
    vendorId: number;
    idempotencyKey: string;
  }): Promise<DropshipListingConfigKeyedRequestRecord | null>;
  replaceConfig(
    input: ReplaceDropshipStoreListingConfigRepositoryInput,
  ): Promise<ReplaceDropshipStoreListingConfigRepositoryResult>;
}

/** Why a vendor sees a store's listing settings without being able to change them. */
export type DropshipListingConfigReadOnlyReason =
  | "vendor_not_active"
  | "store_paused"
  | "store_disconnecting"
  | "store_disconnected";

export type DropshipListingConfigAccess =
  | { canEdit: true; reason: null }
  | { canEdit: false; reason: DropshipListingConfigReadOnlyReason };

/**
 * Statuses each writer may save on. Staff keep today's rule (anything but a
 * disconnected store). A vendor's eBay setup saves also need a store that is
 * not paused or being disconnected; a store that needs a new eBay sign-in can
 * still save what needs no eBay call (eBay calls fail first otherwise).
 */
export const DROPSHIP_LISTING_CONFIG_STAFF_WRITE_STATUSES: readonly DropshipStoreConnectionStatus[] = [
  "connected", "needs_reauth", "refresh_failed", "grace_period", "paused",
];
export const DROPSHIP_LISTING_CONFIG_VENDOR_SETUP_WRITE_STATUSES: readonly DropshipStoreConnectionStatus[] = [
  "connected", "needs_reauth", "refresh_failed",
];
export const DROPSHIP_LISTING_CONFIG_SYSTEM_SETUP_WRITE_STATUSES: readonly DropshipStoreConnectionStatus[] = [
  "connected", "refresh_failed",
];

export interface DropshipListingConfigReplaceOptions {
  request?: DropshipListingConfigKeyedRequest | null;
  auditEventType?: DropshipListingConfigAuditEventType;
  allowedStoreStatuses?: readonly DropshipStoreConnectionStatus[];
}

export interface DropshipListingConfigServiceDependencies {
  vendorProvisioning: DropshipVendorProvisioningService;
  repository: DropshipListingConfigRepository;
  clock: DropshipClock;
  logger: DropshipLogger;
}

export type NormalizedDropshipStoreListingConfigInput = ReplaceDropshipStoreListingConfigInput;

export class DropshipListingConfigService {
  constructor(private readonly deps: DropshipListingConfigServiceDependencies) {}

  async getForMember(memberId: string, storeConnectionId: number): Promise<{
    vendor: DropshipProvisionedVendorProfile;
    storeConnection: DropshipListingConfigStoreConnectionContext;
    config: DropshipStoreListingConfigRecord;
  }> {
    const vendor = (await this.deps.vendorProvisioning.provisionForMember(memberId)).vendor;
    assertVendorCanManageListingConfig(vendor);
    const storeConnection = await this.requireStoreConnection(vendor.vendorId, storeConnectionId);
    const config = await this.deps.repository.ensureDefaultConfig({
      vendorId: vendor.vendorId,
      storeConnectionId,
      platform: storeConnection.platform,
      actor: { actorType: "vendor", actorId: memberId },
      now: this.deps.clock.now(),
    });

    return { vendor, storeConnection, config };
  }

  /**
   * The vendor's view of a store's listing config, readable even when it can't
   * be changed (design 3.5, 8.8): a closed, lapsed or suspended account, or a
   * paused, disconnecting or disconnected store, gets a read-only view instead
   * of an error. A read-only view never creates the config row.
   */
  async getViewForMember(memberId: string, storeConnectionId: number): Promise<{
    vendor: DropshipProvisionedVendorProfile;
    storeConnection: DropshipListingConfigStoreConnectionContext;
    config: DropshipStoreListingConfigRecord | null;
    access: DropshipListingConfigAccess;
  }> {
    const vendor = (await this.deps.vendorProvisioning.provisionForMember(memberId)).vendor;
    const storeConnection = await this.requireStoreConnection(vendor.vendorId, storeConnectionId);
    const access = decideDropshipListingConfigAccess(vendor.status, storeConnection.status);
    if (!access.canEdit) {
      const config = await this.deps.repository.findConfig({ storeConnectionId });
      return { vendor, storeConnection, config, access };
    }
    const config = await this.deps.repository.ensureDefaultConfig({
      vendorId: vendor.vendorId,
      storeConnectionId,
      platform: storeConnection.platform,
      actor: { actorType: "vendor", actorId: memberId },
      now: this.deps.clock.now(),
    });
    return { vendor, storeConnection, config, access };
  }

  async getForAdmin(storeConnectionId: number, actor: DropshipListingConfigActor): Promise<{
    storeConnection: DropshipListingConfigStoreConnectionContext;
    config: DropshipStoreListingConfigRecord;
  }> {
    const storeConnection = await this.requireStoreConnectionForAdmin(storeConnectionId);
    const config = await this.deps.repository.ensureDefaultConfig({
      vendorId: storeConnection.vendorId,
      storeConnectionId,
      platform: storeConnection.platform,
      actor,
      now: this.deps.clock.now(),
    });

    return { storeConnection, config };
  }

  /** The vendor's earlier keyed request, so a retry is answered before any eBay call or revision check. */
  async findKeyedRequest(input: {
    vendorId: number;
    idempotencyKey: string;
  }): Promise<DropshipListingConfigKeyedRequestRecord | null> {
    return this.deps.repository.findKeyedRequest(input);
  }

  /** Read-only: the stored config as it is now, or null. Never creates one. */
  async findConfig(input: { storeConnectionId: number }): Promise<DropshipStoreListingConfigRecord | null> {
    return this.deps.repository.findConfig(input);
  }

  async replaceForMember(
    memberId: string,
    storeConnectionId: number,
    input: unknown,
    options: DropshipListingConfigReplaceOptions = {},
  ): Promise<{
    vendor: DropshipProvisionedVendorProfile;
    storeConnection: DropshipListingConfigStoreConnectionContext;
    config: DropshipStoreListingConfigRecord;
    outcome: DropshipListingConfigWriteOutcome;
    revisionBefore: number;
    revisionAfter: number;
  }> {
    const parsed = replaceDropshipStoreListingConfigRequestSchema.parse(input);
    const requestKey = options.request?.idempotencyKey ?? null;
    const operation = options.auditEventType ?? "listing_config_replaced";
    // Who and where are checked inside the refusal log too, so a save refused
    // because the account was suspended while it ran is traced like any other.
    const { vendor, storeConnection } = await this.refusalsLogged({
      vendorId: null,
      storeConnectionId,
      platform: null,
      actorType: "vendor",
      expectedRevision: parsed.expectedRevision,
      requestKey,
      operation,
    }, async () => {
      const provisioned = (await this.deps.vendorProvisioning.provisionForMember(memberId)).vendor;
      assertVendorCanManageListingConfig(provisioned);
      return {
        vendor: provisioned,
        storeConnection: await this.requireStoreConnection(provisioned.vendorId, storeConnectionId),
      };
    });
    // A vendor writes only where the setup page lets them: not on a paused,
    // disconnecting or disconnected store (those are read-only views).
    const allowedStoreStatuses = options.allowedStoreStatuses ?? DROPSHIP_LISTING_CONFIG_VENDOR_SETUP_WRITE_STATUSES;
    const logContext: ListingConfigWriteLogContext = {
      vendorId: vendor.vendorId,
      storeConnectionId,
      platform: storeConnection.platform,
      actorType: "vendor",
      expectedRevision: parsed.expectedRevision,
      requestKey,
      operation,
    };
    const written = await this.refusalsLogged(logContext, async () => {
      assertStoreStatusAllowsListingConfigWrite(storeConnection, allowedStoreStatuses);
      return this.deps.repository.replaceConfig({
        vendorId: vendor.vendorId,
        storeConnectionId,
        platform: storeConnection.platform,
        config: normalizeListingConfigInput(parsed),
        expectedRevision: parsed.expectedRevision,
        allowedStoreStatuses,
        request: options.request ?? null,
        auditEventType: options.auditEventType ?? "listing_config_replaced",
        actor: { actorType: "vendor", actorId: memberId },
        now: this.deps.clock.now(),
      });
    });
    this.logWrite(written, logContext);

    return { vendor, storeConnection, ...written };
  }

  async replaceForAdmin(
    storeConnectionId: number,
    input: unknown,
    actor: DropshipListingConfigActor,
    options: DropshipListingConfigReplaceOptions = {},
  ): Promise<{
    storeConnection: DropshipListingConfigStoreConnectionContext;
    config: DropshipStoreListingConfigRecord;
    outcome: DropshipListingConfigWriteOutcome;
    revisionBefore: number;
    revisionAfter: number;
  }> {
    const parsed = replaceDropshipStoreListingConfigRequestSchema.parse(input);
    const requestKey = options.request?.idempotencyKey ?? null;
    const operation = options.auditEventType ?? "listing_config_replaced";
    const storeConnection = await this.refusalsLogged({
      vendorId: null,
      storeConnectionId,
      platform: null,
      actorType: actor.actorType,
      expectedRevision: parsed.expectedRevision,
      requestKey,
      operation,
    }, () => this.requireStoreConnectionForAdmin(storeConnectionId));
    const allowedStoreStatuses = options.allowedStoreStatuses ?? DROPSHIP_LISTING_CONFIG_STAFF_WRITE_STATUSES;
    const logContext: ListingConfigWriteLogContext = {
      vendorId: storeConnection.vendorId,
      storeConnectionId,
      platform: storeConnection.platform,
      actorType: actor.actorType,
      expectedRevision: parsed.expectedRevision,
      requestKey,
      operation,
    };
    const written = await this.refusalsLogged(logContext, async () => {
      assertStoreStatusAllowsListingConfigWrite(storeConnection, allowedStoreStatuses);
      return this.deps.repository.replaceConfig({
        vendorId: storeConnection.vendorId,
        storeConnectionId,
        platform: storeConnection.platform,
        config: normalizeListingConfigInput(parsed),
        expectedRevision: parsed.expectedRevision,
        allowedStoreStatuses,
        request: options.request ?? null,
        auditEventType: options.auditEventType ?? "listing_config_replaced",
        actor,
        now: this.deps.clock.now(),
      });
    });
    this.logWrite(written, logContext);

    return { storeConnection, ...written };
  }

  /**
   * One line for a write that did not happen, so a disputed save can be
   * traced. A refusal by the rules (a moved revision, a reused key, a store
   * that can't be changed, a blocked account) is INFO: the logger port has no
   * DEBUG level, and it is not a fault. A broken invariant is ERROR, for a
   * person to look at (dropshipListingConfigFault). Other errors are rethrown
   * untouched for the caller to report.
   */
  private async refusalsLogged<T>(
    context: ListingConfigRefusalLogContext,
    write: () => Promise<T>,
  ): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if (error instanceof DropshipError) {
        const fields = {
          ...context,
          vendorId: context.vendorId ?? numberOrNull(error.context?.vendorId),
          errorCode: error.code,
          currentRevision: error.context?.currentRevision ?? null,
        };
        if (dropshipListingConfigFault(error.code)) {
          this.deps.logger.error({
            code: "DROPSHIP_LISTING_CONFIG_WRITE_FAILED",
            message: "Dropship store listing configuration write failed a check that should always hold; nothing was written.",
            context: { ...fields, outcome: "failed" },
          });
        } else {
          this.deps.logger.info({
            code: "DROPSHIP_LISTING_CONFIG_WRITE_REFUSED",
            message: "Dropship store listing configuration write was refused; nothing was written.",
            context: { ...fields, outcome: "refused" },
          });
        }
      }
      throw error;
    }
  }

  private logWrite(
    written: ReplaceDropshipStoreListingConfigRepositoryResult,
    context: ListingConfigWriteLogContext,
  ): void {
    // One line per write, naming its outcome. The logger port has no DEBUG
    // level, so the expected no-op outcomes are INFO too, never WARN.
    this.deps.logger.info({
      code: written.outcome === "changed"
        ? "DROPSHIP_LISTING_CONFIG_REPLACED"
        : written.outcome === "replayed"
          ? "DROPSHIP_LISTING_CONFIG_REPLAYED"
          : "DROPSHIP_LISTING_CONFIG_UNCHANGED",
      message: written.outcome === "changed"
        ? "Dropship store listing configuration replaced."
        : written.outcome === "replayed"
          ? "Dropship store listing configuration request replayed by its key; nothing was written."
          : "Dropship store listing configuration already matched; nothing was written.",
      context: {
        ...context,
        outcome: written.outcome,
        revisionBefore: written.revisionBefore,
        revisionAfter: written.revisionAfter,
        currentRevision: written.config.revision,
        listingMode: written.config.listingMode,
        inventoryMode: written.config.inventoryMode,
        priceMode: written.config.priceMode,
        isActive: written.config.isActive,
      },
    });
  }

  private async requireStoreConnection(
    vendorId: number,
    storeConnectionId: number,
  ): Promise<DropshipListingConfigStoreConnectionContext> {
    const storeConnection = await this.deps.repository.loadStoreConnectionContext({
      vendorId,
      storeConnectionId,
    });
    if (!storeConnection) {
      throw new DropshipError(
        "DROPSHIP_STORE_CONNECTION_NOT_FOUND",
        "Dropship store connection was not found.",
        { vendorId, storeConnectionId },
      );
    }
    return storeConnection;
  }

  private async requireStoreConnectionForAdmin(
    storeConnectionId: number,
  ): Promise<DropshipListingConfigStoreConnectionContext> {
    const storeConnection = await this.deps.repository.loadStoreConnectionContextById({
      storeConnectionId,
    });
    if (!storeConnection) {
      throw new DropshipError(
        "DROPSHIP_STORE_CONNECTION_NOT_FOUND",
        "Dropship store connection was not found.",
        { storeConnectionId },
      );
    }
    return storeConnection;
  }
}

interface ListingConfigWriteLogContext {
  vendorId: number;
  storeConnectionId: number;
  platform: DropshipSourcePlatform;
  actorType: DropshipListingConfigActor["actorType"];
  expectedRevision: number;
  requestKey: string | null;
  operation: DropshipListingConfigAuditEventType;
}

/** A refusal can come before the vendor or the store is known. */
type ListingConfigRefusalLogContext = Omit<ListingConfigWriteLogContext, "vendorId" | "platform"> & {
  vendorId: number | null;
  platform: DropshipSourcePlatform | null;
};

/**
 * Codes that mean a check that should always hold did not (a revision the
 * trigger did not advance, a keyed request without an actor, a revision that
 * is not a positive integer, an editable view without a config): a fault for
 * a person to look at, never an expected refusal.
 */
export function dropshipListingConfigFault(code: string): boolean {
  return code.endsWith("_INVARIANT_FAILED") || LISTING_CONFIG_FAULT_CODES.has(code);
}

const LISTING_CONFIG_FAULT_CODES: ReadonlySet<string> = new Set([
  "DROPSHIP_LISTING_CONFIG_REQUEST_ACTOR_REQUIRED",
  "DROPSHIP_LISTING_CONFIG_REVISION_INVALID",
  "DROPSHIP_LISTING_CONFIG_REQUIRED",
]);

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/** Closed, lapsed and suspended accounts may read their settings but not change them. */
const DROPSHIP_LISTING_CONFIG_BLOCKED_VENDOR_STATUSES: ReadonlySet<string> = new Set(["closed", "lapsed", "suspended"]);

export function decideDropshipListingConfigAccess(
  vendorStatus: string,
  storeStatus: DropshipStoreConnectionStatus,
): DropshipListingConfigAccess {
  if (DROPSHIP_LISTING_CONFIG_BLOCKED_VENDOR_STATUSES.has(vendorStatus)) {
    return { canEdit: false, reason: "vendor_not_active" };
  }
  if (storeStatus === "paused") return { canEdit: false, reason: "store_paused" };
  if (storeStatus === "grace_period") return { canEdit: false, reason: "store_disconnecting" };
  if (storeStatus === "disconnected") return { canEdit: false, reason: "store_disconnected" };
  return { canEdit: true, reason: null };
}

/**
 * Refuses a write on a store whose status the writer may not save on. The
 * repository repeats this under the store's row lock, so a store paused while
 * a save was checking eBay is still refused.
 */
export function assertStoreStatusAllowsListingConfigWrite(
  storeConnection: { vendorId: number; storeConnectionId: number; status: DropshipStoreConnectionStatus },
  allowedStatuses: readonly DropshipStoreConnectionStatus[],
): void {
  if (allowedStatuses.includes(storeConnection.status)) return;
  throw listingConfigStoreStatusError(storeConnection.status, {
    vendorId: storeConnection.vendorId,
    storeConnectionId: storeConnection.storeConnectionId,
  });
}

/** The error for a vendor who may only read these settings, by the reason they are read-only. */
export function dropshipListingConfigReadOnlyError(
  reason: DropshipListingConfigReadOnlyReason,
  context: { vendorId?: number; storeConnectionId: number },
): DropshipError {
  switch (reason) {
    case "vendor_not_active":
      return new DropshipError(
        "DROPSHIP_LISTING_CONFIG_VENDOR_BLOCKED",
        "Dropship vendor status does not allow listing configuration changes.",
        { ...context, retryable: false },
      );
    case "store_paused":
      return listingConfigStoreStatusError("paused", context);
    case "store_disconnecting":
      return listingConfigStoreStatusError("grace_period", context);
    case "store_disconnected":
      return listingConfigStoreStatusError("disconnected", context);
  }
}

function listingConfigStoreStatusError(
  status: DropshipStoreConnectionStatus,
  context: { vendorId?: number; storeConnectionId: number },
): DropshipError {
  const errorContext = { ...context, status, retryable: false };
  switch (status) {
    case "paused":
      return new DropshipError(
        "DROPSHIP_LISTING_CONFIG_STORE_PAUSED",
        "This store is paused, so its listing settings can't be changed now.",
        errorContext,
      );
    case "grace_period":
      return new DropshipError(
        "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTING",
        "This store is being disconnected, so its listing settings can't be changed now.",
        errorContext,
      );
    case "disconnected":
      return new DropshipError(
        "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTED",
        "Disconnected store connections cannot be updated for dropship listing configuration.",
        errorContext,
      );
    default:
      return new DropshipError(
        "DROPSHIP_LISTING_CONFIG_STORE_NOT_WRITABLE",
        "This store's connection status does not allow this listing settings change.",
        errorContext,
      );
  }
}

/** The config fields a write compares, audits and stores; everything but identity and timestamps. */
export interface DropshipStoreListingConfigContent {
  listingMode: DropshipListingMode;
  inventoryMode: DropshipListingInventoryMode;
  priceMode: DropshipListingPriceMode;
  marketplaceConfig: Record<string, unknown>;
  requiredConfigKeys: string[];
  requiredProductFields: string[];
  isActive: boolean;
}

export function listingConfigContent(
  config: DropshipStoreListingConfigContent,
): DropshipStoreListingConfigContent {
  return {
    listingMode: config.listingMode,
    inventoryMode: config.inventoryMode,
    priceMode: config.priceMode,
    marketplaceConfig: config.marketplaceConfig,
    requiredConfigKeys: [...config.requiredConfigKeys],
    requiredProductFields: [...config.requiredProductFields],
    isActive: config.isActive,
  };
}

/** True when a write would store exactly what the row already says (key order does not matter). */
export function listingConfigContentEquals(
  left: DropshipStoreListingConfigContent,
  right: DropshipStoreListingConfigContent,
): boolean {
  // Compared as the JSON PostgreSQL stores, so a value jsonb cannot tell
  // apart (-0 and 0) never counts as a change the trigger would not see.
  return isDeepStrictEqual(asStoredJson(listingConfigContent(left)), asStoredJson(listingConfigContent(right)));
}

/**
 * The value as it reads back from a jsonb column: -0 becomes 0, a
 * non-finite number becomes null and undefined members disappear, exactly as
 * JSON.stringify writes them. Finite numbers and strings are unchanged.
 */
function asStoredJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * The fields a write changed, for the audit row: top-level fields by name and
 * marketplace config keys as paths (one level into businessPolicies,
 * businessPolicyNames and storeShelfDefault), sorted. Pure and deterministic.
 */
export function listingConfigChangedFields(
  before: DropshipStoreListingConfigContent,
  after: DropshipStoreListingConfigContent,
): string[] {
  const changed = new Set<string>();
  for (const field of ["listingMode", "inventoryMode", "priceMode", "requiredConfigKeys", "requiredProductFields", "isActive"] as const) {
    if (!isDeepStrictEqual(before[field], after[field])) changed.add(field);
  }
  const nestedKeys = new Set(["businessPolicies", "businessPolicyNames", "storeShelfDefault"]);
  const keys = new Set([...Object.keys(before.marketplaceConfig), ...Object.keys(after.marketplaceConfig)]);
  for (const key of keys) {
    const left = before.marketplaceConfig[key];
    const right = after.marketplaceConfig[key];
    if (isDeepStrictEqual(left, right)) continue;
    if (nestedKeys.has(key) && isPlainRecord(left) && isPlainRecord(right)) {
      for (const nested of new Set([...Object.keys(left), ...Object.keys(right)])) {
        if (!isDeepStrictEqual(left[nested], right[nested])) changed.add(`marketplaceConfig.${key}.${nested}`);
      }
    } else {
      changed.add(`marketplaceConfig.${key}`);
    }
  }
  return [...changed].sort();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function buildDefaultDropshipStoreListingConfig(
  platform: DropshipSourcePlatform,
): NormalizedDropshipStoreListingConfigInput & { platform: DropshipSourcePlatform } {
  if (platform === "ebay") {
    return {
      platform,
      listingMode: DROPSHIP_DEFAULT_EBAY_LISTING_MODE,
      inventoryMode: DROPSHIP_DEFAULT_LISTING_INVENTORY_MODE,
      priceMode: DROPSHIP_DEFAULT_LISTING_PRICE_MODE,
      marketplaceConfig: {
        marketplaceId: DROPSHIP_DEFAULT_EBAY_MARKETPLACE_ID,
      },
      requiredConfigKeys: [
        "marketplaceId",
        "merchantLocationKey",
        "businessPolicies.paymentPolicyId",
        "businessPolicies.returnPolicyId",
        "businessPolicies.fulfillmentPolicyId",
      ],
      requiredProductFields: [
        "sku",
        "title",
        "description",
        "imageUrls",
        "ebayBrowseCategoryId",
      ],
      isActive: true,
    };
  }

  return {
    platform,
    listingMode: DROPSHIP_DEFAULT_LISTING_MODE,
    inventoryMode: DROPSHIP_DEFAULT_LISTING_INVENTORY_MODE,
    priceMode: DROPSHIP_DEFAULT_LISTING_PRICE_MODE,
    marketplaceConfig: {},
    requiredConfigKeys: [],
    requiredProductFields: [],
    isActive: true,
  };
}

export function normalizeListingConfigInput(
  input: ReplaceDropshipStoreListingConfigInput,
): NormalizedDropshipStoreListingConfigInput {
  return {
    listingMode: input.listingMode,
    inventoryMode: input.inventoryMode,
    priceMode: input.priceMode,
    // Stored as jsonb; normalized now so the compare, the audit and the row agree.
    marketplaceConfig: asStoredJson(input.marketplaceConfig),
    requiredConfigKeys: uniqueTrimmed(input.requiredConfigKeys),
    requiredProductFields: uniqueTrimmed(input.requiredProductFields),
    isActive: input.isActive,
  };
}

export function makeDropshipListingConfigLogger(): DropshipLogger {
  return {
    info: (event) => logDropshipListingConfigEvent("info", event),
    warn: (event) => logDropshipListingConfigEvent("warn", event),
    error: (event) => logDropshipListingConfigEvent("error", event),
  };
}

export const systemDropshipListingConfigClock: DropshipClock = {
  now: () => new Date(),
};

function assertVendorCanManageListingConfig(vendor: DropshipProvisionedVendorProfile): void {
  if (["closed", "lapsed", "suspended"].includes(vendor.status)) {
    throw new DropshipError(
      "DROPSHIP_LISTING_CONFIG_VENDOR_BLOCKED",
      "Dropship vendor status does not allow listing configuration changes.",
      { vendorId: vendor.vendorId, status: vendor.status },
    );
  }
}

function uniqueTrimmed<T extends string>(values: readonly T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const trimmed = value.trim() as T;
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}

function logDropshipListingConfigEvent(
  level: "info" | "warn" | "error",
  event: DropshipLogEvent,
): void {
  const payload = JSON.stringify({
    code: event.code,
    message: event.message,
    context: event.context ?? {},
  });
  if (level === "error") {
    console.error(payload);
    return;
  }
  if (level === "warn") {
    console.warn(payload);
    return;
  }
  console.info(payload);
}
