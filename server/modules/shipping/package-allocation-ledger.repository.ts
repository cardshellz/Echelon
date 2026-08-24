import type { Pool, PoolClient } from "pg";

import type { PersistedDeclaredPackageEvidence } from "./declared-package-lifecycle-shadow.domain";
import type {
  PackageAllocationEffectIntentV1,
  PackageAllocationEntryV1,
  PackageAllocationGroupPackageEvidenceV1,
  PackageAllocationGroupStateV1,
} from "./package-allocation-group.domain";
import type {
  PackageAllocationSourceFacts,
  PackageAllocationSourceRegistrationV1,
} from "./package-allocation-source-identity.domain";
import {
  PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_MAX_PACKAGES,
  PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_RELATIONSHIP_TYPES,
  PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_REQUIRED_RELATIONS,
  PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_SQL,
  type PackageAllocationAuthorityDiscoveryRelationshipType,
} from "./package-allocation-authority-discovery.query";

const SOURCE_LOCK_NAMESPACE = 918_421;
const LABEL_LOCK_NAMESPACE = 918_422;
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_TRANSACTION_TIMEOUT_MS = 60_000;
const JSON_BATCH_SIZE = 1_000;
const MAX_AUTHORITY_SOURCE_LINES = 500;
const MAX_AUTHORITY_PACKAGES = PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_MAX_PACKAGES;
const MAX_AUTHORITY_EVENTS_PER_PACKAGE = 5_000;
const MAX_AUTHORITY_TOTAL_EVENTS = 10_000;
const MAX_AUTHORITY_CURRENT_CARRIER_EVENTS = 5_000;
const MAX_AUTHORITY_EVENT_PAYLOAD_BYTES = 4 * 1_024 * 1_024;
const MAX_AUTHORITY_TOTAL_PAYLOAD_BYTES = 8 * 1_024 * 1_024;

const AUTHORITY_DISCOVERY_RELATIONSHIP_TYPE_SET = new Set<string>(
  PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_RELATIONSHIP_TYPES,
);

export const PACKAGE_ALLOCATION_AUTHORITY_PREVIEW_REQUIRED_RELATIONS:
readonly string[] = Object.freeze([...new Set([
  ...PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_REQUIRED_RELATIONS,
  "catalog.product_variants",
  "wms.carrier_tracking_event_matches",
  "wms.carrier_tracking_events",
  "wms.carrier_tracking_reconciliation_state",
  "wms.order_items",
  "wms.package_allocation_groups",
  "wms.shipping_provider_label_events",
])].sort());

type QueryClient = Pick<PoolClient, "query">;

export type PackageAllocationLedgerRepositoryErrorCode =
  | "ALLOCATION_KEY_CONFLICT"
  | "CONCURRENT_WRITE"
  | "DATABASE_ERROR"
  | "INVALID_DATABASE_EVIDENCE"
  | "LEDGER_INVARIANT_VIOLATION"
  | "PACKAGE_BINDING_CONFLICT"
  | "PACKAGE_EVIDENCE_NOT_FOUND"
  | "ROLLBACK_FAILED"
  | "RELEASE_FAILED"
  | "SOURCE_ALREADY_GROUPED"
  | "SOURCE_EVIDENCE_NOT_FOUND"
  | "SOURCE_REGISTRATION_CONFLICT"
  | "STALE_GROUP_VERSION";

export class PackageAllocationLedgerRepositoryError extends Error {
  readonly code: PackageAllocationLedgerRepositoryErrorCode;
  readonly context: Readonly<Record<string, unknown>>;
  override readonly cause?: unknown;

  constructor(
    code: PackageAllocationLedgerRepositoryErrorCode,
    message: string,
    context: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message);
    this.name = "PackageAllocationLedgerRepositoryError";
    this.code = code;
    this.context = Object.freeze({ ...context });
    this.cause = cause;
  }
}

export interface LockedPackageAllocationGroup {
  readonly id: string;
  readonly groupKey: string;
  readonly currentVersion: number;
}

export interface PersistedPackageAllocationPlan {
  readonly id: string;
  readonly packageAllocationGroupId: string;
  readonly planVersion: number;
  readonly expectedGroupVersion: number;
  readonly inputHash: string;
  readonly stateHash: string;
  readonly outcome: "proposed" | "review";
  readonly plannerVersion: string;
  readonly reason: string;
  readonly createdBy: string;
  readonly stateSnapshot: unknown;
  readonly reviewSnapshot: unknown;
}

export interface RegisteredPackageAllocationSource {
  readonly id: string;
  readonly registration: PackageAllocationSourceRegistrationV1;
}

export interface RegisteredPackageAllocationBinding {
  readonly id: string;
  readonly packageKey: string;
  readonly provider: string;
  readonly providerPhysicalShipmentId: string;
  readonly identityHash: string;
}

export interface PersistedPackageAllocationEntry {
  readonly entryKey: string;
  readonly allocationKey: string;
  readonly sourceWmsShipmentItemId: number;
  readonly allocationKind: string;
  readonly targetKind: string;
  readonly packageKey: string | null;
  readonly shippingProviderLabelId: string | null;
  readonly quantity: number;
}

export interface PersistedPackageAllocationIntent {
  readonly intentKey: string;
  readonly effectType: string;
  readonly payloadHash: string;
  readonly sourceWmsShipmentItemId: number | null;
  readonly packageKey: string | null;
  readonly shippingProviderLabelId: string | null;
  readonly quantity: number | null;
  readonly payload: unknown;
  readonly executable: boolean;
}

export interface LockedPackageAllocationAuthorityEvidence {
  readonly evidenceKey: string;
  readonly persistedEvidence: PersistedDeclaredPackageEvidence;
}

export interface PackageAllocationAuthorityDiscoveredPackageEvidence {
  readonly shippingProviderLabelId: number;
  readonly relationshipTypes: readonly PackageAllocationAuthorityDiscoveryRelationshipType[];
}

export interface AppendPackageAllocationPlanInput {
  readonly group: LockedPackageAllocationGroup;
  readonly planVersion: number;
  readonly inputHash: string;
  readonly stateHash: string;
  readonly outcome: "proposed" | "review";
  readonly plannerVersion: string;
  readonly reason: string;
  readonly createdBy: string;
  readonly stateSnapshot: PackageAllocationGroupStateV1;
  readonly reviewSnapshot: Readonly<{ contractVersion: 1; reviews: PackageAllocationGroupStateV1["reviews"] }>;
  readonly entries: readonly PackageAllocationEntryV1[];
  readonly intents: readonly PackageAllocationEffectIntentV1[];
  readonly sourcesByWmsItemId: ReadonlyMap<number, RegisteredPackageAllocationSource>;
  readonly bindingsByPackageKey: ReadonlyMap<string, RegisteredPackageAllocationBinding>;
}

export interface PackageAllocationAuthorityPreviewTransaction {
  readGroup(groupKey: string): Promise<LockedPackageAllocationGroup | null>;
  readSourceFacts(sourceWmsShipmentItemIds: readonly number[]): Promise<readonly PackageAllocationSourceFacts[]>;
  discoverAuthorityReadinessPackageSelection(
    sourceWmsShipmentItemIds: readonly number[],
  ): Promise<readonly PackageAllocationAuthorityDiscoveredPackageEvidence[]>;
  readAuthorityReadinessPackages(
    shippingProviderLabelIds: readonly number[],
  ): Promise<readonly LockedPackageAllocationAuthorityEvidence[]>;
}

export interface PackageAllocationAuthorityPreviewRepository {
  withRepeatableReadOnlyTransaction<T>(
    work: (transaction: PackageAllocationAuthorityPreviewTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface PackageAllocationLedgerTransaction {
  lockGroup(groupKey: string, createIfMissing: boolean): Promise<LockedPackageAllocationGroup | null>;
  lockSourceFacts(sourceWmsShipmentItemIds: readonly number[]): Promise<readonly PackageAllocationSourceFacts[]>;
  discoverAuthorityReadinessPackageSelection(
    sourceWmsShipmentItemIds: readonly number[],
  ): Promise<readonly PackageAllocationAuthorityDiscoveredPackageEvidence[]>;
  lockAuthorityReadinessPackages(
    shippingProviderLabelIds: readonly number[],
  ): Promise<readonly LockedPackageAllocationAuthorityEvidence[]>;
  ensureSourceRegistrations(
    group: LockedPackageAllocationGroup,
    registrations: readonly PackageAllocationSourceRegistrationV1[],
    allowCreate: boolean,
  ): Promise<ReadonlyMap<number, RegisteredPackageAllocationSource>>;
  ensurePackageBindings(
    group: LockedPackageAllocationGroup,
    packages: readonly PackageAllocationGroupPackageEvidenceV1[],
    allowCreate: boolean,
  ): Promise<ReadonlyMap<string, RegisteredPackageAllocationBinding>>;
  loadPlanByVersion(groupId: string, planVersion: number): Promise<PersistedPackageAllocationPlan | null>;
  loadPlanByInputHash(groupId: string, inputHash: string): Promise<PersistedPackageAllocationPlan | null>;
  loadPlanEntries(planId: string): Promise<readonly PersistedPackageAllocationEntry[]>;
  loadPlanIntents(planId: string): Promise<readonly PersistedPackageAllocationIntent[]>;
  appendPlan(input: AppendPackageAllocationPlanInput): Promise<string>;
}

export interface PackageAllocationLedgerRepository {
  withSerializableTransaction<T>(
    work: (transaction: PackageAllocationLedgerTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface PgPackageAllocationLedgerRepositoryOptions {
  readonly statementTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
  readonly idleTransactionTimeoutMs?: number;
}

interface PgErrorShape {
  readonly code?: unknown;
  readonly constraint?: unknown;
}

function pgErrorCode(error: unknown): string | null {
  const value = (error as PgErrorShape | null)?.code;
  return typeof value === "string" ? value : null;
}

function pgConstraint(error: unknown): string | null {
  const value = (error as PgErrorShape | null)?.constraint;
  return typeof value === "string" ? value : null;
}

function classifyDatabaseError(error: unknown): PackageAllocationLedgerRepositoryError {
  if (error instanceof PackageAllocationLedgerRepositoryError) return error;
  const code = pgErrorCode(error);
  const context = { postgresCode: code, constraint: pgConstraint(error) };
  if (code === "40001" || code === "40P01" || code === "55P03") {
    return new PackageAllocationLedgerRepositoryError(
      "CONCURRENT_WRITE",
      "The package allocation transaction conflicted with another writer",
      context,
      error,
    );
  }
  if (code === "23503" || code === "23505" || code === "23514" || code === "55000") {
    return new PackageAllocationLedgerRepositoryError(
      "LEDGER_INVARIANT_VIOLATION",
      "The package allocation ledger rejected an invalid write",
      context,
      error,
    );
  }
  return new PackageAllocationLedgerRepositoryError(
    "DATABASE_ERROR",
    "The package allocation ledger transaction failed",
    context,
    error,
  );
}

function classifyTransactionWorkError(error: unknown): unknown {
  if (error instanceof PackageAllocationLedgerRepositoryError) return error;
  if (error instanceof Error && error.name.startsWith("PackageAllocation")) return error;
  return classifyDatabaseError(error);
}

function errorCodeForContext(error: unknown): string | null {
  const value = (error as { readonly code?: unknown } | null)?.code;
  return typeof value === "string" ? value : null;
}


function positiveInteger(value: unknown, field: string): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(numberValue) || numberValue <= 0 || numberValue > 2_147_483_647) {
    throw new PackageAllocationLedgerRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `Database field ${field} is not a positive PostgreSQL integer`,
      { field },
    );
  }
  return numberValue;
}

function nonnegativeInteger(value: unknown, field: string): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(numberValue) || numberValue < 0 || numberValue > 2_147_483_647) {
    throw new PackageAllocationLedgerRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `Database field ${field} is not a nonnegative PostgreSQL integer`,
      { field },
    );
  }
  return numberValue;
}

function positiveSafeInteger(value: unknown, field: string): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(numberValue) || numberValue <= 0) {
    throw new PackageAllocationLedgerRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `Database field ${field} is not a positive safe integer`,
      { field },
    );
  }
  return numberValue;
}


function nullablePositiveInteger(value: unknown, field: string): number | null {
  return value === null || value === undefined ? null : positiveInteger(value, field);
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PackageAllocationLedgerRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `Database field ${field} is missing or blank`,
      { field },
    );
  }
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function bigintText(value: unknown, field: string): string {
  const normalized = String(value);
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw new PackageAllocationLedgerRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `Database field ${field} is not a positive bigint identifier`,
      { field },
    );
  }
  return normalized;
}

function optionalBigintText(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : bigintText(value, field);
}

function timestampText(value: unknown, field: string): string {
  const date =
    value instanceof Date
      ? value
      : typeof value === "string" || typeof value === "number"
        ? new Date(value)
        : null;
  if (date === null || !Number.isFinite(Date.prototype.getTime.call(date))) {
    throw new PackageAllocationLedgerRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `Database field ${field} is not a valid timestamp`,
      { field },
    );
  }
  return Date.prototype.toISOString.call(date);
}


function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new PackageAllocationLedgerRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `Database field ${field} is not boolean`,
      { field },
    );
  }
  return value;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function discoveryRelationshipTypes(
  value: unknown,
): readonly PackageAllocationAuthorityDiscoveryRelationshipType[] {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.length > PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_RELATIONSHIP_TYPES.length
  ) {
    throw new PackageAllocationLedgerRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      "Authority package discovery returned invalid relationship evidence",
      { field: "relationship_types" },
    );
  }
  const relationshipTypes = value.map((raw) => {
    const relationshipType = requiredText(raw, "relationship_types");
    if (!AUTHORITY_DISCOVERY_RELATIONSHIP_TYPE_SET.has(relationshipType)) {
      throw new PackageAllocationLedgerRepositoryError(
        "INVALID_DATABASE_EVIDENCE",
        "Authority package discovery returned an unknown relationship type",
        { field: "relationship_types" },
      );
    }
    return relationshipType as PackageAllocationAuthorityDiscoveryRelationshipType;
  }).sort(compareText);
  if (new Set(relationshipTypes).size !== relationshipTypes.length) {
    throw new PackageAllocationLedgerRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      "Authority package discovery returned duplicate relationship evidence",
      { field: "relationship_types" },
    );
  }
  return Object.freeze(relationshipTypes);
}

function chunks<T>(values: readonly T[]): readonly (readonly T[])[] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += JSON_BATCH_SIZE) {
    result.push(values.slice(index, index + JSON_BATCH_SIZE));
  }
  return result;
}

function sameNullableNumber(left: number | null, right: number | null): boolean {
  return left === right;
}

function sourceRegistrationMatches(
  actual: PackageAllocationSourceRegistrationV1,
  expected: PackageAllocationSourceRegistrationV1,
): boolean {
  return actual.contractVersion === expected.contractVersion
    && actual.sourceWmsShipmentItemId === expected.sourceWmsShipmentItemId
    && actual.shipmentRequestItemId === expected.shipmentRequestItemId
    && actual.sourceQuantity === expected.sourceQuantity
    && actual.shipmentItemPurpose === expected.shipmentItemPurpose
    && sameNullableNumber(actual.orderItemId, expected.orderItemId)
    && sameNullableNumber(actual.replacementForOrderItemId, expected.replacementForOrderItemId)
    && sameNullableNumber(actual.correctionForShipmentItemId, expected.correctionForShipmentItemId)
    && sameNullableNumber(actual.productVariantId, expected.productVariantId)
    && actual.sku === expected.sku
    && actual.sourceFingerprint === expected.sourceFingerprint;
}

class PgPackageAllocationLedgerTransaction
  implements PackageAllocationLedgerTransaction, PackageAllocationAuthorityPreviewTransaction {
  constructor(private readonly client: QueryClient) {}

  async readGroup(
    groupKey: string,
  ): Promise<LockedPackageAllocationGroup | null> {
    return this.loadGroup(groupKey, false);
  }

  async lockGroup(
    groupKey: string,
    createIfMissing: boolean,
  ): Promise<LockedPackageAllocationGroup | null> {
    await this.client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`package-allocation-group:${groupKey}`],
    );
    if (createIfMissing) {
      await this.client.query(
        `INSERT INTO wms.package_allocation_groups (group_key)
         VALUES ($1::uuid)
         ON CONFLICT (group_key) DO NOTHING`,
        [groupKey],
      );
    }
    return this.loadGroup(groupKey, true);
  }

  private async loadGroup(
    groupKey: string,
    lockRows: boolean,
  ): Promise<LockedPackageAllocationGroup | null> {
    const rowLockClause = lockRows ? "\n       FOR UPDATE" : "";
    const result = await this.client.query(
      `SELECT id::text AS id, group_key::text AS group_key, current_version
       FROM wms.package_allocation_groups
       WHERE group_key = $1::uuid${rowLockClause}`,
      [groupKey],
    );
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) {
      throw new PackageAllocationLedgerRepositoryError(
        "INVALID_DATABASE_EVIDENCE",
        "A package allocation group key resolved to multiple rows",
        { groupKey },
      );
    }
    const row = result.rows[0] as Record<string, unknown>;
    return Object.freeze({
      id: bigintText(row.id, "package_allocation_groups.id"),
      groupKey: requiredText(
        row.group_key,
        "package_allocation_groups.group_key",
      ).toLowerCase(),
      currentVersion: nonnegativeInteger(
        row.current_version,
        "package_allocation_groups.current_version",
      ),
    });
  }

  async readSourceFacts(
    sourceWmsShipmentItemIds: readonly number[],
  ): Promise<readonly PackageAllocationSourceFacts[]> {
    return this.loadSourceFacts(sourceWmsShipmentItemIds, false);
  }

  async lockSourceFacts(
    sourceWmsShipmentItemIds: readonly number[],
  ): Promise<readonly PackageAllocationSourceFacts[]> {
    return this.loadSourceFacts(sourceWmsShipmentItemIds, true);
  }

  private async loadSourceFacts(
    sourceWmsShipmentItemIds: readonly number[],
    lockRows: boolean,
  ): Promise<readonly PackageAllocationSourceFacts[]> {
    const sortedIds = [...new Set(sourceWmsShipmentItemIds)].sort((left, right) => left - right);
    if (lockRows) {
      for (const sourceId of sortedIds) {
        await this.client.query(
          "SELECT pg_advisory_xact_lock($1, $2)",
          [SOURCE_LOCK_NAMESPACE, sourceId],
        );
      }
    }
    const rowLockClause = lockRows ? "\n       FOR UPDATE OF shipment_item" : "";
    const result = await this.client.query(
      `SELECT
         shipment_item.id AS source_wms_shipment_item_id,
         request_item.id::text AS shipment_request_item_id,
         shipment_item.qty AS source_quantity,
         shipment_item.shipment_item_purpose,
         shipment_item.order_item_id,
         shipment_item.replacement_for_order_item_id,
         shipment_item.correction_for_shipment_item_id,
         shipment_item.product_variant_id,
         order_item.sku AS order_item_sku,
         replacement_item.sku AS replacement_order_item_sku,
         variant.sku AS product_variant_sku
       FROM wms.outbound_shipment_items AS shipment_item
       LEFT JOIN wms.shipment_request_items AS request_item
         ON request_item.legacy_wms_shipment_item_id = shipment_item.id
       LEFT JOIN wms.order_items AS order_item
         ON order_item.id = shipment_item.order_item_id
       LEFT JOIN wms.order_items AS replacement_item
         ON replacement_item.id = shipment_item.replacement_for_order_item_id
       LEFT JOIN catalog.product_variants AS variant
         ON variant.id = shipment_item.product_variant_id
       WHERE shipment_item.id = ANY($1::integer[])
       ORDER BY shipment_item.id${rowLockClause}`,
      [sortedIds],
    );
    if (result.rows.length !== sortedIds.length) {
      const found = new Set(result.rows.map((row: any) => Number(row.source_wms_shipment_item_id)));
      throw new PackageAllocationLedgerRepositoryError(
        "SOURCE_EVIDENCE_NOT_FOUND",
        "One or more WMS shipment source items do not exist",
        { missingWmsShipmentItemIds: sortedIds.filter((id) => !found.has(id)) },
      );
    }
    return Object.freeze(result.rows.map((raw) => {
      const row = raw as Record<string, unknown>;
      return Object.freeze({
        sourceWmsShipmentItemId: positiveInteger(row.source_wms_shipment_item_id, "source_wms_shipment_item_id"),
        shipmentRequestItemId: optionalBigintText(row.shipment_request_item_id, "shipment_request_item_id"),
        sourceQuantity: positiveInteger(row.source_quantity, "source_quantity"),
        shipmentItemPurpose: requiredText(row.shipment_item_purpose, "shipment_item_purpose") as PackageAllocationSourceFacts["shipmentItemPurpose"],
        orderItemId: nullablePositiveInteger(row.order_item_id, "order_item_id"),
        replacementForOrderItemId: nullablePositiveInteger(row.replacement_for_order_item_id, "replacement_for_order_item_id"),
        correctionForShipmentItemId: nullablePositiveInteger(row.correction_for_shipment_item_id, "correction_for_shipment_item_id"),
        productVariantId: nullablePositiveInteger(row.product_variant_id, "product_variant_id"),
        orderItemSku: nullableText(row.order_item_sku),
        replacementOrderItemSku: nullableText(row.replacement_order_item_sku),
        productVariantSku: nullableText(row.product_variant_sku),
      });
    }));
  }

  async discoverAuthorityReadinessPackageSelection(
    sourceWmsShipmentItemIds: readonly number[],
  ): Promise<readonly PackageAllocationAuthorityDiscoveredPackageEvidence[]> {
    const sortedIds = [...new Set(sourceWmsShipmentItemIds)].sort(
      (left, right) => left - right,
    );
    if (
      sortedIds.length === 0
      || sortedIds.length > MAX_AUTHORITY_SOURCE_LINES
    ) {
      throw new PackageAllocationLedgerRepositoryError(
        "INVALID_DATABASE_EVIDENCE",
        "Authority package discovery received an out-of-bounds source set",
        {
          observedSourceCount: sortedIds.length,
          maxSourceCount: MAX_AUTHORITY_SOURCE_LINES,
        },
      );
    }
    for (const sourceId of sortedIds) {
      if (
        !Number.isInteger(sourceId)
        || sourceId <= 0
        || sourceId > 2_147_483_647
      ) {
        throw new PackageAllocationLedgerRepositoryError(
          "INVALID_DATABASE_EVIDENCE",
          "Authority package discovery received an invalid WMS source identifier",
          { sourceWmsShipmentItemId: sourceId },
        );
      }
    }

    const result = await this.client.query(
      PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_SQL,
      [sortedIds, MAX_AUTHORITY_PACKAGES + 1],
    );
    if (result.rows.length === 0) {
      throw new PackageAllocationLedgerRepositoryError(
        "INVALID_DATABASE_EVIDENCE",
        "Authority package discovery did not return its source summary",
      );
    }

    const summary = result.rows[0] as Record<string, unknown>;
    const sourceCount = nonnegativeInteger(
      summary.source_count,
      "source_count",
    );
    if (!Array.isArray(summary.found_source_ids)) {
      throw new PackageAllocationLedgerRepositoryError(
        "INVALID_DATABASE_EVIDENCE",
        "Authority package discovery returned invalid source identity evidence",
      );
    }
    const foundSourceIds = summary.found_source_ids.map((value) =>
      positiveInteger(value, "found_source_ids"),
    );
    if (sourceCount !== foundSourceIds.length) {
      throw new PackageAllocationLedgerRepositoryError(
        "INVALID_DATABASE_EVIDENCE",
        "Authority package discovery returned inconsistent source evidence",
      );
    }
    const foundSourceIdSet = new Set(foundSourceIds);
    if (sourceCount !== sortedIds.length) {
      throw new PackageAllocationLedgerRepositoryError(
        "SOURCE_EVIDENCE_NOT_FOUND",
        "One or more WMS source items disappeared during package discovery",
        {
          missingWmsShipmentItemIds: sortedIds.filter(
            (sourceId) => !foundSourceIdSet.has(sourceId),
          ),
        },
      );
    }

    const packages = result.rows.flatMap((raw) => {
      const row = raw as Record<string, unknown>;
      if (row.shipping_provider_label_id === null) return [];
      return [Object.freeze({
        shippingProviderLabelId: positiveSafeInteger(
          row.shipping_provider_label_id,
          "shipping_provider_label_id",
        ),
        relationshipTypes: discoveryRelationshipTypes(row.relationship_types),
      })];
    });
    if (packages.length === 0) {
      throw new PackageAllocationLedgerRepositoryError(
        "PACKAGE_EVIDENCE_NOT_FOUND",
        "No outbound shipping-provider label is related to the locked WMS source set",
        { sourceWmsShipmentItemIds: sortedIds },
      );
    }
    if (packages.length > MAX_AUTHORITY_PACKAGES) {
      throw new PackageAllocationLedgerRepositoryError(
        "INVALID_DATABASE_EVIDENCE",
        "Authority package discovery exceeded its package-count safety bound",
        {
          observedPackageCount: packages.length,
          maxPackageCount: MAX_AUTHORITY_PACKAGES,
        },
      );
    }
    const labelIds = packages.map((pkg) => pkg.shippingProviderLabelId);
    if (new Set(labelIds).size !== labelIds.length) {
      throw new PackageAllocationLedgerRepositoryError(
        "INVALID_DATABASE_EVIDENCE",
        "Authority package discovery returned duplicate package identities",
      );
    }
    return Object.freeze(packages);
  }

  async readAuthorityReadinessPackages(
    shippingProviderLabelIds: readonly number[],
  ): Promise<readonly LockedPackageAllocationAuthorityEvidence[]> {
    return this.loadAuthorityReadinessPackages(shippingProviderLabelIds, false);
  }

  async lockAuthorityReadinessPackages(
    shippingProviderLabelIds: readonly number[],
  ): Promise<readonly LockedPackageAllocationAuthorityEvidence[]> {
    return this.loadAuthorityReadinessPackages(shippingProviderLabelIds, true);
  }

  private async loadAuthorityReadinessPackages(
    shippingProviderLabelIds: readonly number[],
    lockRows: boolean,
  ): Promise<readonly LockedPackageAllocationAuthorityEvidence[]> {
    const sortedIds = [...new Set(shippingProviderLabelIds)].sort(
      (left, right) => left - right,
    );
    if (sortedIds.length === 0 || sortedIds.length > MAX_AUTHORITY_PACKAGES) {
      throw new PackageAllocationLedgerRepositoryError(
        "INVALID_DATABASE_EVIDENCE",
        "Authority readiness package selection is outside its bounded contract",
        {
          observedPackageCount: sortedIds.length,
          maxPackageCount: MAX_AUTHORITY_PACKAGES,
        },
      );
    }
    for (const labelId of sortedIds) {
      if (!Number.isSafeInteger(labelId) || labelId <= 0) {
        throw new PackageAllocationLedgerRepositoryError(
          "INVALID_DATABASE_EVIDENCE",
          "Authority readiness received an invalid shipping-provider label identifier",
          { shippingProviderLabelId: labelId },
        );
      }
      if (lockRows) {
        await this.client.query("SELECT pg_advisory_xact_lock($1, $2)", [
          LABEL_LOCK_NAMESPACE,
          labelId,
        ]);
      }
    }

    const labelRowLockClause = lockRows ? "\n         FOR UPDATE" : "";
    const carrierRowLockClause = lockRows
      ? "\n       FOR KEY SHARE OF reconciliation_state, match, carrier_event"
      : "";
    const labelResult = await this.client.query(
      `WITH locked_labels AS MATERIALIZED (
         SELECT
           label.id,
           label.provider,
           label.provider_label_id,
           label.tracking_number,
           label.label_status,
           label.label_direction,
           label.first_observed_at,
           label.last_observed_at
         FROM wms.shipping_provider_labels AS label
         WHERE label.id = ANY($1::bigint[])
         ORDER BY label.id${labelRowLockClause}
       ),
       event_stats AS (
         SELECT
           locked.id AS shipping_provider_label_id,
           COUNT(event.id)::text AS label_event_count,
           COALESCE(SUM(octet_length(event.sanitized_payload::text)), 0)::text
             AS label_event_payload_bytes,
           COALESCE(MAX(octet_length(event.sanitized_payload::text)), 0)::text
             AS max_event_payload_bytes
         FROM locked_labels AS locked
         LEFT JOIN wms.shipping_provider_label_events AS event
           ON event.shipping_provider_label_id = locked.id
         GROUP BY locked.id
       )
       SELECT
         locked.id::text AS shipping_provider_label_id,
         locked.provider,
         locked.provider_label_id,
         locked.tracking_number,
         locked.label_status,
         locked.label_direction,
         locked.first_observed_at,
         locked.last_observed_at,
         event_stats.label_event_count,
         event_stats.label_event_payload_bytes,
         event_stats.max_event_payload_bytes
       FROM locked_labels AS locked
       JOIN event_stats
         ON event_stats.shipping_provider_label_id = locked.id
       ORDER BY locked.id`,
      [sortedIds],
    );
    if (labelResult.rows.length !== sortedIds.length) {
      const found = new Set(
        labelResult.rows.map((row: any) =>
          positiveSafeInteger(
            row.shipping_provider_label_id,
            "shipping_provider_label_id",
          ),
        ),
      );
      throw new PackageAllocationLedgerRepositoryError(
        "INVALID_DATABASE_EVIDENCE",
        "One or more requested shipping-provider labels do not exist",
        {
          missingShippingProviderLabelIds: sortedIds.filter(
            (id) => !found.has(id),
          ),
        },
      );
    }

    let expectedEventCount = 0;
    let totalPayloadBytes = 0;
    for (const raw of labelResult.rows) {
      const row = raw as Record<string, unknown>;
      const labelId = positiveSafeInteger(
        row.shipping_provider_label_id,
        "shipping_provider_label_id",
      );
      const eventCount = nonnegativeInteger(
        row.label_event_count,
        "label_event_count",
      );
      const payloadBytes = nonnegativeInteger(
        row.label_event_payload_bytes,
        "label_event_payload_bytes",
      );
      const maxPayloadBytes = nonnegativeInteger(
        row.max_event_payload_bytes,
        "max_event_payload_bytes",
      );
      if (
        eventCount > MAX_AUTHORITY_EVENTS_PER_PACKAGE ||
        payloadBytes > MAX_AUTHORITY_EVENT_PAYLOAD_BYTES ||
        maxPayloadBytes > MAX_AUTHORITY_EVENT_PAYLOAD_BYTES
      ) {
        throw new PackageAllocationLedgerRepositoryError(
          "INVALID_DATABASE_EVIDENCE",
          "A requested package exceeds its authority evidence safety bound",
          {
            shippingProviderLabelId: labelId,
            eventCount,
            payloadBytes,
            maxPayloadBytes,
          },
        );
      }
      expectedEventCount += eventCount;
      totalPayloadBytes += payloadBytes;
    }
    if (
      expectedEventCount > MAX_AUTHORITY_TOTAL_EVENTS ||
      totalPayloadBytes > MAX_AUTHORITY_TOTAL_PAYLOAD_BYTES
    ) {
      throw new PackageAllocationLedgerRepositoryError(
        "INVALID_DATABASE_EVIDENCE",
        "Requested package evidence exceeds its aggregate safety bound",
        { expectedEventCount, totalPayloadBytes },
      );
    }

    const eventResult =
      expectedEventCount === 0
        ? { rows: [] as Record<string, unknown>[] }
        : await this.client.query(
            `SELECT
           event.id::text AS label_event_id,
           event.shipping_provider_label_id::text AS shipping_provider_label_id,
           event.event_hash,
           event.event_type,
           event.label_status,
           event.tracking_number,
           event.provider_occurred_at,
           event.received_at,
           event.sanitized_payload
         FROM wms.shipping_provider_label_events AS event
         WHERE event.shipping_provider_label_id = ANY($1::bigint[])
         ORDER BY event.shipping_provider_label_id, event.received_at, event.id
         LIMIT $2`,
            [sortedIds, expectedEventCount + 1],
          );
    if (eventResult.rows.length !== expectedEventCount) {
      throw new PackageAllocationLedgerRepositoryError(
        "INVALID_DATABASE_EVIDENCE",
        "Authority readiness did not receive one complete label-event history",
        { expectedEventCount, observedEventCount: eventResult.rows.length },
      );
    }

    const carrierResult = await this.client.query(
      `SELECT
         carrier_event.id::text AS carrier_tracking_event_id,
         match.shipping_provider_label_id::text AS shipping_provider_label_id,
         carrier_event.dispatch_evidence,
         match.match_status,
         carrier_event.event_occurred_at,
         carrier_event.received_at
       FROM wms.carrier_tracking_reconciliation_state AS reconciliation_state
       JOIN wms.carrier_tracking_event_matches AS match
         ON match.id = reconciliation_state.last_match_attempt_id
        AND match.carrier_tracking_event_id = reconciliation_state.carrier_tracking_event_id
        AND match.attempt_hash = reconciliation_state.last_match_attempt_hash
        AND match.match_status = reconciliation_state.last_match_status
       JOIN wms.carrier_tracking_events AS carrier_event
         ON carrier_event.id = reconciliation_state.carrier_tracking_event_id
       WHERE match.shipping_provider_label_id = ANY($1::bigint[])
         AND carrier_event.dispatch_evidence = 'confirmed'
         AND match.match_status IN ('matched', 'voided_label')
       ORDER BY match.shipping_provider_label_id, carrier_event.received_at, carrier_event.id
       LIMIT $2${carrierRowLockClause}`,
      [sortedIds, MAX_AUTHORITY_CURRENT_CARRIER_EVENTS + 1],
    );
    if (carrierResult.rows.length > MAX_AUTHORITY_CURRENT_CARRIER_EVENTS) {
      throw new PackageAllocationLedgerRepositoryError(
        "INVALID_DATABASE_EVIDENCE",
        "Current confirmed carrier evidence exceeds its aggregate safety bound",
        {
          observedCurrentCarrierEventCount: carrierResult.rows.length,
          maxCurrentCarrierEventCount: MAX_AUTHORITY_CURRENT_CARRIER_EVENTS,
        },
      );
    }

    const selectedIds = new Set(sortedIds);
    const eventsByLabelId = new Map<
      number,
      PersistedDeclaredPackageEvidence["labelEvents"][number][]
    >();
    for (const raw of eventResult.rows) {
      const row = raw as Record<string, unknown>;
      const labelId = positiveSafeInteger(
        row.shipping_provider_label_id,
        "shipping_provider_label_id",
      );
      if (!selectedIds.has(labelId)) {
        throw new PackageAllocationLedgerRepositoryError(
          "INVALID_DATABASE_EVIDENCE",
          "Authority readiness received a label event outside the locked package set",
        );
      }
      const events = eventsByLabelId.get(labelId) ?? [];
      events.push(
        Object.freeze({
          id: positiveSafeInteger(row.label_event_id, "label_event_id"),
          shippingProviderLabelId: labelId,
          eventHash: requiredText(row.event_hash, "event_hash"),
          eventType: requiredText(row.event_type, "event_type"),
          labelStatus: requiredText(row.label_status, "label_status"),
          trackingNumber: requiredText(row.tracking_number, "tracking_number"),
          providerOccurredAt:
            row.provider_occurred_at === null
              ? null
              : timestampText(row.provider_occurred_at, "provider_occurred_at"),
          sanitizedPayload: row.sanitized_payload,
          receivedAt: timestampText(row.received_at, "received_at"),
        }),
      );
      eventsByLabelId.set(labelId, events);
    }

    const carrierByLabelId = new Map<
      number,
      PersistedDeclaredPackageEvidence["confirmedCarrierEvents"][number][]
    >();
    for (const raw of carrierResult.rows) {
      const row = raw as Record<string, unknown>;
      const labelId = positiveSafeInteger(
        row.shipping_provider_label_id,
        "shipping_provider_label_id",
      );
      if (!selectedIds.has(labelId)) {
        throw new PackageAllocationLedgerRepositoryError(
          "INVALID_DATABASE_EVIDENCE",
          "Authority readiness received carrier evidence outside the locked package set",
        );
      }
      const dispatchEvidence = requiredText(
        row.dispatch_evidence,
        "dispatch_evidence",
      );
      const currentMatchStatus = requiredText(row.match_status, "match_status");
      if (
        dispatchEvidence !== "confirmed" ||
        (currentMatchStatus !== "matched" &&
          currentMatchStatus !== "voided_label")
      ) {
        throw new PackageAllocationLedgerRepositoryError(
          "INVALID_DATABASE_EVIDENCE",
          "Authority readiness received non-current carrier evidence",
          { shippingProviderLabelId: labelId },
        );
      }
      const events = carrierByLabelId.get(labelId) ?? [];
      events.push(
        Object.freeze({
          id: positiveSafeInteger(
            row.carrier_tracking_event_id,
            "carrier_tracking_event_id",
          ),
          shippingProviderLabelId: labelId,
          dispatchEvidence,
          currentMatchStatus,
          eventOccurredAt:
            row.event_occurred_at === null
              ? null
              : timestampText(row.event_occurred_at, "event_occurred_at"),
          receivedAt: timestampText(row.received_at, "received_at"),
        }),
      );
      carrierByLabelId.set(labelId, events);
    }

    return Object.freeze(
      labelResult.rows.map((raw) => {
        const row = raw as Record<string, unknown>;
        const labelId = positiveSafeInteger(
          row.shipping_provider_label_id,
          "shipping_provider_label_id",
        );
        const currentLabelStatus = requiredText(
          row.label_status,
          "label_status",
        );
        if (
          !["active", "voided", "superseded", "unknown"].includes(
            currentLabelStatus,
          )
        ) {
          throw new PackageAllocationLedgerRepositoryError(
            "INVALID_DATABASE_EVIDENCE",
            "Authority readiness received an unsupported current label status",
            { shippingProviderLabelId: labelId },
          );
        }
        const persistedEvidence: PersistedDeclaredPackageEvidence =
          Object.freeze({
            shippingProviderLabelId: labelId,
            provider: requiredText(row.provider, "provider").toLowerCase(),
            providerPhysicalShipmentId: requiredText(
              row.provider_label_id,
              "provider_label_id",
            ),
            currentTrackingNumber: requiredText(
              row.tracking_number,
              "tracking_number",
            ),
            currentLabelStatus:
              currentLabelStatus as PersistedDeclaredPackageEvidence["currentLabelStatus"],
            firstObservedAt: timestampText(
              row.first_observed_at,
              "first_observed_at",
            ),
            lastObservedAt: timestampText(
              row.last_observed_at,
              "last_observed_at",
            ),
            labelDirection: requiredText(
              row.label_direction,
              "label_direction",
            ),
            labelEvents: Object.freeze(eventsByLabelId.get(labelId) ?? []),
            confirmedCarrierEvents: Object.freeze(
              carrierByLabelId.get(labelId) ?? [],
            ),
          });
        return Object.freeze({
          evidenceKey: `shipping-provider-label:${labelId}`,
          persistedEvidence,
        });
      }),
    );
  }

  async ensureSourceRegistrations(
    group: LockedPackageAllocationGroup,
    registrations: readonly PackageAllocationSourceRegistrationV1[],
    allowCreate: boolean,
  ): Promise<ReadonlyMap<number, RegisteredPackageAllocationSource>> {
    const sorted = [...registrations].sort(
      (left, right) => left.sourceWmsShipmentItemId - right.sourceWmsShipmentItemId,
    );
    const sourceRows = sorted.map((registration) => ({
      source_wms_shipment_item_id: registration.sourceWmsShipmentItemId,
      shipment_request_item_id: registration.shipmentRequestItemId,
      source_quantity: registration.sourceQuantity,
      shipment_item_purpose: registration.shipmentItemPurpose,
      order_item_id: registration.orderItemId,
      replacement_for_order_item_id: registration.replacementForOrderItemId,
      correction_for_shipment_item_id: registration.correctionForShipmentItemId,
      product_variant_id: registration.productVariantId,
      sku: registration.sku,
      source_fingerprint: registration.sourceFingerprint,
    }));
    if (allowCreate) {
      await this.client.query(
        `INSERT INTO wms.package_allocation_source_lines (
           source_wms_shipment_item_id, shipment_request_item_id, source_quantity,
           shipment_item_purpose, order_item_id, replacement_for_order_item_id,
           correction_for_shipment_item_id, product_variant_id, sku, source_fingerprint
         )
         SELECT
           row.source_wms_shipment_item_id,
           row.shipment_request_item_id,
           row.source_quantity,
           row.shipment_item_purpose,
           row.order_item_id,
           row.replacement_for_order_item_id,
           row.correction_for_shipment_item_id,
           row.product_variant_id,
           row.sku,
           row.source_fingerprint
         FROM jsonb_to_recordset($1::jsonb) AS row(
           source_wms_shipment_item_id integer,
           shipment_request_item_id bigint,
           source_quantity integer,
           shipment_item_purpose text,
           order_item_id integer,
           replacement_for_order_item_id integer,
           correction_for_shipment_item_id integer,
           product_variant_id integer,
           sku text,
           source_fingerprint text
         )
         ORDER BY row.source_wms_shipment_item_id
         ON CONFLICT (source_wms_shipment_item_id) DO NOTHING`,
        [JSON.stringify(sourceRows)],
      );
    }
    const result = await this.client.query(
      `SELECT
         id::text AS id,
         source_wms_shipment_item_id,
         shipment_request_item_id::text AS shipment_request_item_id,
         source_quantity,
         shipment_item_purpose,
         order_item_id,
         replacement_for_order_item_id,
         correction_for_shipment_item_id,
         product_variant_id,
         sku,
         source_fingerprint
       FROM wms.package_allocation_source_lines
       WHERE source_wms_shipment_item_id = ANY($1::integer[])
       ORDER BY source_wms_shipment_item_id
       FOR KEY SHARE`,
      [sorted.map((row) => row.sourceWmsShipmentItemId)],
    );
    const expectedByWmsId = new Map(sorted.map((registration) => [
      registration.sourceWmsShipmentItemId,
      registration,
    ]));
    const registered = new Map<number, RegisteredPackageAllocationSource>();
    for (const raw of result.rows) {
      const row = raw as Record<string, unknown>;
      const wmsId = positiveInteger(row.source_wms_shipment_item_id, "source_wms_shipment_item_id");
      const actual: PackageAllocationSourceRegistrationV1 = Object.freeze({
        contractVersion: 1,
        sourceWmsShipmentItemId: wmsId,
        shipmentRequestItemId: optionalBigintText(row.shipment_request_item_id, "shipment_request_item_id"),
        sourceQuantity: positiveInteger(row.source_quantity, "source_quantity"),
        shipmentItemPurpose: requiredText(row.shipment_item_purpose, "shipment_item_purpose") as PackageAllocationSourceRegistrationV1["shipmentItemPurpose"],
        orderItemId: nullablePositiveInteger(row.order_item_id, "order_item_id"),
        replacementForOrderItemId: nullablePositiveInteger(row.replacement_for_order_item_id, "replacement_for_order_item_id"),
        correctionForShipmentItemId: nullablePositiveInteger(row.correction_for_shipment_item_id, "correction_for_shipment_item_id"),
        productVariantId: nullablePositiveInteger(row.product_variant_id, "product_variant_id"),
        sku: requiredText(row.sku, "sku"),
        sourceFingerprint: requiredText(row.source_fingerprint, "source_fingerprint"),
      });
      const expected = expectedByWmsId.get(wmsId);
      if (!expected || !sourceRegistrationMatches(actual, expected)) {
        throw new PackageAllocationLedgerRepositoryError(
          "SOURCE_REGISTRATION_CONFLICT",
          "A WMS shipment item is already registered with different immutable evidence",
          { sourceWmsShipmentItemId: wmsId },
        );
      }
      registered.set(wmsId, Object.freeze({
        id: bigintText(row.id, "package_allocation_source_lines.id"),
        registration: actual,
      }));
    }
    if (registered.size !== sorted.length) {
      throw new PackageAllocationLedgerRepositoryError(
        "SOURCE_EVIDENCE_NOT_FOUND",
        "One or more package allocation source registrations are missing",
        {
          missingWmsShipmentItemIds: sorted
            .map((row) => row.sourceWmsShipmentItemId)
            .filter((id) => !registered.has(id)),
        },
      );
    }
    if (allowCreate) {
      const memberships = [...registered.values()].map((source) => ({
        package_allocation_group_id: group.id,
        package_allocation_source_line_id: source.id,
      }));
      await this.client.query(
        `INSERT INTO wms.package_allocation_group_source_lines (
           package_allocation_group_id, package_allocation_source_line_id
         )
         SELECT row.package_allocation_group_id, row.package_allocation_source_line_id
         FROM jsonb_to_recordset($1::jsonb) AS row(
           package_allocation_group_id bigint,
           package_allocation_source_line_id bigint
         )
         ORDER BY row.package_allocation_source_line_id
         ON CONFLICT (package_allocation_group_id, package_allocation_source_line_id) DO NOTHING`,
        [JSON.stringify(memberships)],
      );
    }
    const membershipResult = await this.client.query(
      `SELECT source_line.source_wms_shipment_item_id
       FROM wms.package_allocation_group_source_lines AS membership
       JOIN wms.package_allocation_source_lines AS source_line
         ON source_line.id = membership.package_allocation_source_line_id
       WHERE membership.package_allocation_group_id = $1::bigint
       ORDER BY source_line.source_wms_shipment_item_id
       FOR KEY SHARE OF membership`,
      [group.id],
    );
    const actualMembership = membershipResult.rows.map((row: any) => (
      positiveInteger(row.source_wms_shipment_item_id, "source_wms_shipment_item_id")
    ));
    const expectedMembership = sorted.map((row) => row.sourceWmsShipmentItemId);
    if (JSON.stringify(actualMembership) !== JSON.stringify(expectedMembership)) {
      const overlapping = actualMembership.filter((id) => !expectedMembership.includes(id));
      throw new PackageAllocationLedgerRepositoryError(
        overlapping.length > 0 ? "SOURCE_ALREADY_GROUPED" : "SOURCE_REGISTRATION_CONFLICT",
        "The package allocation group source membership does not match the planner source set",
        { groupKey: group.groupKey, actualMembership, expectedMembership },
      );
    }
    return registered;
  }

  async ensurePackageBindings(
    group: LockedPackageAllocationGroup,
    packages: readonly PackageAllocationGroupPackageEvidenceV1[],
    allowCreate: boolean,
  ): Promise<ReadonlyMap<string, RegisteredPackageAllocationBinding>> {
    const sorted = [...packages].sort((left, right) => (
      compareText(left.provider, right.provider)
      || compareText(left.providerPhysicalShipmentId, right.providerPhysicalShipmentId)
      || compareText(left.packageKey, right.packageKey)
    ));
    for (const pkg of sorted) {
      await this.client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`package-allocation-package:${pkg.provider}:${pkg.providerPhysicalShipmentId}`],
      );
    }
    if (allowCreate) {
      await this.client.query(
        `INSERT INTO wms.package_allocation_package_bindings (
           package_allocation_group_id, package_key, provider,
           provider_physical_shipment_id, identity_hash
         )
         SELECT
           $1::bigint,
           row.package_key,
           row.provider,
           row.provider_physical_shipment_id,
           row.identity_hash
         FROM jsonb_to_recordset($2::jsonb) AS row(
           package_key text,
           provider text,
           provider_physical_shipment_id text,
           identity_hash text
         )
         ORDER BY row.provider, row.provider_physical_shipment_id, row.package_key
         ON CONFLICT (package_allocation_group_id, package_key) DO NOTHING`,
        [group.id, JSON.stringify(sorted.map((pkg) => ({
          package_key: pkg.packageKey,
          provider: pkg.provider,
          provider_physical_shipment_id: pkg.providerPhysicalShipmentId,
          identity_hash: pkg.identityHash,
        })))],
      );
    }
    const result = await this.client.query(
      `SELECT
         id::text AS id,
         package_key,
         provider,
         provider_physical_shipment_id,
         identity_hash
       FROM wms.package_allocation_package_bindings
       WHERE package_allocation_group_id = $1::bigint
         AND package_key = ANY($2::text[])
       ORDER BY package_key
       FOR KEY SHARE`,
      [group.id, sorted.map((pkg) => pkg.packageKey)],
    );
    const expectedByKey = new Map(sorted.map((pkg) => [pkg.packageKey, pkg]));
    const bindings = new Map<string, RegisteredPackageAllocationBinding>();
    for (const raw of result.rows) {
      const row = raw as Record<string, unknown>;
      const packageKey = requiredText(row.package_key, "package_key");
      const actual = Object.freeze({
        id: bigintText(row.id, "package_allocation_package_bindings.id"),
        packageKey,
        provider: requiredText(row.provider, "provider").toLowerCase(),
        providerPhysicalShipmentId: requiredText(row.provider_physical_shipment_id, "provider_physical_shipment_id"),
        identityHash: requiredText(row.identity_hash, "identity_hash"),
      });
      const expected = expectedByKey.get(packageKey);
      if (!expected
          || actual.provider !== expected.provider
          || actual.providerPhysicalShipmentId !== expected.providerPhysicalShipmentId
          || actual.identityHash !== expected.identityHash) {
        throw new PackageAllocationLedgerRepositoryError(
          "PACKAGE_BINDING_CONFLICT",
          "A package key is already bound to a different immutable physical package",
          { groupKey: group.groupKey, packageKey },
        );
      }
      bindings.set(packageKey, actual);
    }
    if (bindings.size !== sorted.length) {
      throw new PackageAllocationLedgerRepositoryError(
        "PACKAGE_BINDING_CONFLICT",
        "One or more immutable package bindings are missing",
        {
          groupKey: group.groupKey,
          missingPackageKeys: sorted.map((pkg) => pkg.packageKey).filter((key) => !bindings.has(key)),
        },
      );
    }
    return bindings;
  }

  async loadPlanByVersion(groupId: string, planVersion: number): Promise<PersistedPackageAllocationPlan | null> {
    return this.loadSinglePlan(
      `package_allocation_group_id = $1::bigint AND plan_version = $2::integer`,
      [groupId, planVersion],
    );
  }

  async loadPlanByInputHash(groupId: string, inputHash: string): Promise<PersistedPackageAllocationPlan | null> {
    return this.loadSinglePlan(
      `package_allocation_group_id = $1::bigint AND input_hash = $2`,
      [groupId, inputHash],
    );
  }

  private async loadSinglePlan(predicate: string, values: readonly unknown[]): Promise<PersistedPackageAllocationPlan | null> {
    const result = await this.client.query(
      `SELECT
         id::text AS id,
         package_allocation_group_id::text AS package_allocation_group_id,
         plan_version,
         expected_group_version,
         input_hash,
         state_hash,
         outcome,
         planner_version,
         reason,
         created_by,
         state_snapshot,
         review_snapshot
       FROM wms.package_allocation_plans
       WHERE ${predicate}`,
      [...values],
    );
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) {
      throw new PackageAllocationLedgerRepositoryError(
        "INVALID_DATABASE_EVIDENCE",
        "A package allocation plan lookup returned multiple rows",
      );
    }
    const row = result.rows[0] as Record<string, unknown>;
    const outcome = requiredText(row.outcome, "outcome");
    if (outcome !== "proposed" && outcome !== "review") {
      throw new PackageAllocationLedgerRepositoryError(
        "INVALID_DATABASE_EVIDENCE",
        "A persisted package allocation plan has an unsupported outcome",
        { outcome },
      );
    }
    return Object.freeze({
      id: bigintText(row.id, "package_allocation_plans.id"),
      packageAllocationGroupId: bigintText(row.package_allocation_group_id, "package_allocation_group_id"),
      planVersion: positiveInteger(row.plan_version, "plan_version"),
      expectedGroupVersion: nonnegativeInteger(row.expected_group_version, "expected_group_version"),
      inputHash: requiredText(row.input_hash, "input_hash"),
      stateHash: requiredText(row.state_hash, "state_hash"),
      outcome,
      plannerVersion: requiredText(row.planner_version, "planner_version"),
      reason: requiredText(row.reason, "reason"),
      createdBy: requiredText(row.created_by, "created_by"),
      stateSnapshot: row.state_snapshot,
      reviewSnapshot: row.review_snapshot,
    });
  }

  async loadPlanEntries(planId: string): Promise<readonly PersistedPackageAllocationEntry[]> {
    const result = await this.client.query(
      `SELECT
         entry.entry_key,
         entry.allocation_key,
         source.source_wms_shipment_item_id,
         entry.allocation_kind,
         entry.target_kind,
         binding.package_key,
         entry.shipping_provider_label_id::text AS shipping_provider_label_id,
         entry.quantity
       FROM wms.package_allocation_entries AS entry
       JOIN wms.package_allocation_source_lines AS source
         ON source.id = entry.package_allocation_source_line_id
       LEFT JOIN wms.package_allocation_package_bindings AS binding
         ON binding.id = entry.package_allocation_package_binding_id
       WHERE entry.package_allocation_plan_id = $1::bigint
       ORDER BY entry.entry_key`,
      [planId],
    );
    const entries = result.rows.map((raw) => {
      const row = raw as Record<string, unknown>;
      return Object.freeze({
        entryKey: requiredText(row.entry_key, "entry_key"),
        allocationKey: requiredText(row.allocation_key, "allocation_key"),
        sourceWmsShipmentItemId: positiveInteger(row.source_wms_shipment_item_id, "source_wms_shipment_item_id"),
        allocationKind: requiredText(row.allocation_kind, "allocation_kind"),
        targetKind: requiredText(row.target_kind, "target_kind"),
        packageKey: nullableText(row.package_key),
        shippingProviderLabelId: optionalBigintText(row.shipping_provider_label_id, "shipping_provider_label_id"),
        quantity: positiveInteger(row.quantity, "quantity"),
      });
    });
    entries.sort((left, right) => compareText(left.entryKey, right.entryKey));
    return Object.freeze(entries);
  }

  async loadPlanIntents(planId: string): Promise<readonly PersistedPackageAllocationIntent[]> {
    const result = await this.client.query(
      `SELECT
         intent.intent_key,
         intent.effect_type,
         intent.payload_hash,
         source.source_wms_shipment_item_id,
         binding.package_key,
         intent.shipping_provider_label_id::text AS shipping_provider_label_id,
         intent.quantity,
         intent.payload,
         intent.executable
       FROM wms.package_allocation_effect_intents AS intent
       LEFT JOIN wms.package_allocation_source_lines AS source
         ON source.id = intent.package_allocation_source_line_id
       LEFT JOIN wms.package_allocation_package_bindings AS binding
         ON binding.id = intent.package_allocation_package_binding_id
       WHERE intent.package_allocation_plan_id = $1::bigint
       ORDER BY intent.intent_key`,
      [planId],
    );
    const intents = result.rows.map((raw) => {
      const row = raw as Record<string, unknown>;
      return Object.freeze({
        intentKey: requiredText(row.intent_key, "intent_key"),
        effectType: requiredText(row.effect_type, "effect_type"),
        payloadHash: requiredText(row.payload_hash, "payload_hash"),
        sourceWmsShipmentItemId: nullablePositiveInteger(row.source_wms_shipment_item_id, "source_wms_shipment_item_id"),
        packageKey: nullableText(row.package_key),
        shippingProviderLabelId: optionalBigintText(row.shipping_provider_label_id, "shipping_provider_label_id"),
        quantity: nullablePositiveInteger(row.quantity, "quantity"),
        payload: row.payload,
        executable: booleanValue(row.executable, "executable"),
      });
    });
    intents.sort((left, right) => compareText(left.intentKey, right.intentKey));
    return Object.freeze(intents);
  }

  async appendPlan(input: AppendPackageAllocationPlanInput): Promise<string> {
    const allocationSources = new Map<string, string>();
    for (const entry of input.entries) {
      const source = input.sourcesByWmsItemId.get(entry.wmsShipmentItemId);
      if (!source) {
        throw new PackageAllocationLedgerRepositoryError(
          "INVALID_DATABASE_EVIDENCE",
          "A planner allocation references an unregistered source line",
          { wmsShipmentItemId: entry.wmsShipmentItemId },
        );
      }
      const existing = allocationSources.get(entry.allocationKey);
      if (existing !== undefined && existing !== source.id) {
        throw new PackageAllocationLedgerRepositoryError(
          "ALLOCATION_KEY_CONFLICT",
          "A planner allocation key spans multiple source lines",
          { allocationKey: entry.allocationKey },
        );
      }
      allocationSources.set(entry.allocationKey, source.id);
    }
    const allocationRows = [...allocationSources.entries()]
      .map(([allocationKey, sourceId]) => ({ allocation_key: allocationKey, source_id: sourceId }))
      .sort((left, right) => compareText(left.allocation_key, right.allocation_key));
    for (const batch of chunks(allocationRows)) {
      await this.client.query(
        `INSERT INTO wms.package_allocation_keys (
           allocation_key, package_allocation_source_line_id
         )
         SELECT row.allocation_key, row.source_id
         FROM jsonb_to_recordset($1::jsonb) AS row(allocation_key text, source_id bigint)
         ORDER BY row.allocation_key
         ON CONFLICT (allocation_key) DO NOTHING`,
        [JSON.stringify(batch)],
      );
      const verification = await this.client.query(
        `SELECT allocation_key, package_allocation_source_line_id::text AS source_id
         FROM wms.package_allocation_keys
         WHERE allocation_key = ANY($1::text[])
         ORDER BY allocation_key
         FOR KEY SHARE`,
        [batch.map((row) => row.allocation_key)],
      );
      const actual = new Map(verification.rows.map((row: any) => [
        requiredText(row.allocation_key, "allocation_key"),
        bigintText(row.source_id, "package_allocation_source_line_id"),
      ]));
      for (const expected of batch) {
        if (actual.get(expected.allocation_key) !== expected.source_id) {
          throw new PackageAllocationLedgerRepositoryError(
            "ALLOCATION_KEY_CONFLICT",
            "A stable allocation key is already bound to another source line",
            { allocationKey: expected.allocation_key },
          );
        }
      }
    }

    const planResult = await this.client.query(
      `INSERT INTO wms.package_allocation_plans (
         package_allocation_group_id, plan_version, expected_group_version,
         input_hash, state_hash, outcome, planner_version, reason, created_by,
         state_snapshot, review_snapshot
       ) VALUES (
         $1::bigint, $2::integer, $3::integer,
         $4, $5, $6, $7, $8, $9,
         $10::jsonb, $11::jsonb
       )
       RETURNING id::text AS id`,
      [
        input.group.id,
        input.planVersion,
        input.group.currentVersion,
        input.inputHash,
        input.stateHash,
        input.outcome,
        input.plannerVersion,
        input.reason,
        input.createdBy,
        JSON.stringify(input.stateSnapshot),
        JSON.stringify(input.reviewSnapshot),
      ],
    );
    if (planResult.rows.length !== 1) {
      throw new PackageAllocationLedgerRepositoryError(
        "INVALID_DATABASE_EVIDENCE",
        "The package allocation plan insert returned no identity",
      );
    }
    const planId = bigintText((planResult.rows[0] as any).id, "package_allocation_plans.id");

    const entryRows = input.entries.map((entry) => ({
      entry_key: entry.entryKey,
      allocation_key: entry.allocationKey,
      source_id: input.sourcesByWmsItemId.get(entry.wmsShipmentItemId)!.id,
      allocation_kind: entry.allocationKind,
      target_kind: entry.targetKind,
      package_binding_id: entry.packageKey === null
        ? null
        : input.bindingsByPackageKey.get(entry.packageKey)?.id ?? null,
      quantity: entry.quantity,
    }));
    for (const row of entryRows) {
      if (row.target_kind === "package" && row.package_binding_id === null) {
        throw new PackageAllocationLedgerRepositoryError(
          "PACKAGE_BINDING_CONFLICT",
          "A package allocation target has no immutable package binding",
          { entryKey: row.entry_key },
        );
      }
    }
    for (const batch of chunks(entryRows)) {
      await this.client.query(
        `INSERT INTO wms.package_allocation_entries (
           package_allocation_plan_id, package_allocation_group_id,
           package_allocation_source_line_id, allocation_key, entry_key,
           allocation_kind, target_kind, package_allocation_package_binding_id,
           shipping_provider_label_id, quantity
         )
         SELECT
           $1::bigint, $2::bigint, row.source_id,
           row.allocation_key, row.entry_key, row.allocation_kind, row.target_kind,
           row.package_binding_id, NULL::bigint, row.quantity
         FROM jsonb_to_recordset($3::jsonb) AS row(
           entry_key text,
           allocation_key text,
           source_id bigint,
           allocation_kind text,
           target_kind text,
           package_binding_id bigint,
           quantity integer
         )
         ORDER BY row.entry_key`,
        [planId, input.group.id, JSON.stringify(batch)],
      );
    }

    const intentRows = input.intents.map((intent) => {
      const sourceId = intent.wmsShipmentItemId === null
        ? null
        : input.sourcesByWmsItemId.get(intent.wmsShipmentItemId)?.id ?? null;
      if (intent.wmsShipmentItemId !== null && sourceId === null) {
        throw new PackageAllocationLedgerRepositoryError(
          "SOURCE_EVIDENCE_NOT_FOUND",
          "An effect intent references an unregistered source line",
          { intentKey: intent.intentKey, wmsShipmentItemId: intent.wmsShipmentItemId },
        );
      }
      const packageBindingId = intent.packageKey === null
        ? null
        : input.bindingsByPackageKey.get(intent.packageKey)?.id ?? null;
      if (intent.packageKey !== null && packageBindingId === null) {
        throw new PackageAllocationLedgerRepositoryError(
          "PACKAGE_BINDING_CONFLICT",
          "An effect intent references an unbound physical package",
          { intentKey: intent.intentKey, packageKey: intent.packageKey },
        );
      }
      return {
        intent_key: intent.intentKey,
        effect_type: intent.effectType,
        payload_hash: intent.payloadHash,
        source_id: sourceId,
        package_binding_id: packageBindingId,
        quantity: intent.quantity,
        payload: {
          effectType: intent.effectType,
          subjectKey: intent.subjectKey,
          wmsShipmentItemId: intent.wmsShipmentItemId,
          packageKey: intent.packageKey,
          quantity: intent.quantity,
        },
      };
    });
    for (const batch of chunks(intentRows)) {
      await this.client.query(
        `INSERT INTO wms.package_allocation_effect_intents (
           package_allocation_plan_id, package_allocation_group_id,
           package_allocation_source_line_id, package_allocation_package_binding_id,
           shipping_provider_label_id, intent_key, effect_type, payload_hash,
           quantity, payload, executable
         )
         SELECT
           $1::bigint, $2::bigint, row.source_id, row.package_binding_id,
           NULL::bigint, row.intent_key, row.effect_type, row.payload_hash,
           row.quantity, row.payload, FALSE
         FROM jsonb_to_recordset($3::jsonb) AS row(
           intent_key text,
           effect_type text,
           payload_hash text,
           source_id bigint,
           package_binding_id bigint,
           quantity integer,
           payload jsonb
         )
         ORDER BY row.intent_key`,
        [planId, input.group.id, JSON.stringify(batch)],
      );
    }

    const casResult = await this.client.query(
      `UPDATE wms.package_allocation_groups
       SET current_version = $1::integer,
           version_updated_at = GREATEST(version_updated_at, clock_timestamp())
       WHERE id = $2::bigint
         AND current_version = $3::integer
       RETURNING current_version`,
      [input.planVersion, input.group.id, input.group.currentVersion],
    );
    if (casResult.rows.length !== 1) {
      throw new PackageAllocationLedgerRepositoryError(
        "STALE_GROUP_VERSION",
        "The package allocation group version changed before compare-and-set",
        {
          groupKey: input.group.groupKey,
          expectedGroupVersion: input.group.currentVersion,
        },
      );
    }
    await this.client.query("SET CONSTRAINTS ALL IMMEDIATE");
    return planId;
  }
}

export class PgPackageAllocationLedgerRepository
  implements PackageAllocationLedgerRepository, PackageAllocationAuthorityPreviewRepository {
  private readonly statementTimeoutMs: number;
  private readonly lockTimeoutMs: number;
  private readonly idleTransactionTimeoutMs: number;

  constructor(
    private readonly pool: Pick<Pool, "connect">,
    options: PgPackageAllocationLedgerRepositoryOptions = {},
  ) {
    this.statementTimeoutMs = options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.idleTransactionTimeoutMs = options.idleTransactionTimeoutMs
      ?? DEFAULT_IDLE_TRANSACTION_TIMEOUT_MS;
    for (const [name, value] of Object.entries({
      statementTimeoutMs: this.statementTimeoutMs,
      lockTimeoutMs: this.lockTimeoutMs,
      idleTransactionTimeoutMs: this.idleTransactionTimeoutMs,
    })) {
      if (!Number.isInteger(value) || value <= 0 || value > 300_000) {
        throw new PackageAllocationLedgerRepositoryError(
          "INVALID_DATABASE_EVIDENCE",
          `${name} must be a positive integer no greater than 300000`,
          { field: name },
        );
      }
    }
  }

  async withRepeatableReadOnlyTransaction<T>(
    work: (transaction: PackageAllocationAuthorityPreviewTransaction) => Promise<T>,
  ): Promise<T> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw classifyDatabaseError(error);
    }

    let primaryError: unknown = null;
    let clientDiscardError: Error | undefined;
    let result: T | undefined;
    let workStarted = false;
    let workCompleted = false;
    try {
      await client.query(
        "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      await client.query(
        `SELECT
           set_config('statement_timeout', $1, true),
           set_config('lock_timeout', $2, true),
           set_config('idle_in_transaction_session_timeout', $3, true)`,
        [
          `${this.statementTimeoutMs}ms`,
          `${this.lockTimeoutMs}ms`,
          `${this.idleTransactionTimeoutMs}ms`,
        ],
      );
      workStarted = true;
      result = await work(new PgPackageAllocationLedgerTransaction(client));
      workCompleted = true;
    } catch (error) {
      primaryError = workStarted && !workCompleted
        ? classifyTransactionWorkError(error)
        : classifyDatabaseError(error);
    }

    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      clientDiscardError = rollbackError instanceof Error
        ? rollbackError
        : new Error("The package allocation read-only rollback failed with a non-Error value");
      const rollbackFailure = new PackageAllocationLedgerRepositoryError(
        "ROLLBACK_FAILED",
        primaryError === null
          ? "The package allocation read-only preview rollback failed"
          : "The package allocation read-only preview and its rollback both failed",
        {
          primaryCode: errorCodeForContext(primaryError),
          rollbackPostgresCode: pgErrorCode(rollbackError),
        },
        primaryError === null
          ? rollbackError
          : new AggregateError([primaryError, rollbackError]),
      );
      primaryError = rollbackFailure;
    }

    let releaseError: unknown = null;
    try {
      client.release(clientDiscardError);
    } catch (error) {
      releaseError = error;
    }
    if (releaseError !== null) {
      const errors = primaryError === null
        ? [releaseError]
        : [primaryError, releaseError];
      throw new PackageAllocationLedgerRepositoryError(
        "RELEASE_FAILED",
        primaryError === null
          ? "The package allocation read-only preview completed but client release failed"
          : "The package allocation read-only preview and client release both failed",
        {
          primaryCode: errorCodeForContext(primaryError),
          releaseCode: errorCodeForContext(releaseError),
        },
        new AggregateError(errors),
      );
    }
    if (primaryError !== null) throw primaryError;
    return result as T;
  }

  async withSerializableTransaction<T>(
    work: (transaction: PackageAllocationLedgerTransaction) => Promise<T>,
  ): Promise<T> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw classifyDatabaseError(error);
    }
    let primaryError: unknown = null;
    let clientDiscardError: Error | undefined;
    let result: T | undefined;
    let workStarted = false;
    let workCompleted = false;
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      await client.query(
        `SELECT
           set_config('statement_timeout', $1, true),
           set_config('lock_timeout', $2, true),
           set_config('idle_in_transaction_session_timeout', $3, true)`,
        [
          `${this.statementTimeoutMs}ms`,
          `${this.lockTimeoutMs}ms`,
          `${this.idleTransactionTimeoutMs}ms`,
        ],
      );
      workStarted = true;
      result = await work(new PgPackageAllocationLedgerTransaction(client));
      workCompleted = true;
      await client.query("COMMIT");
    } catch (error) {
      primaryError = workStarted && !workCompleted
        ? classifyTransactionWorkError(error)
        : classifyDatabaseError(error);
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        clientDiscardError = rollbackError instanceof Error
          ? rollbackError
          : new Error("The package allocation rollback failed with a non-Error value");
        primaryError = new PackageAllocationLedgerRepositoryError(
          "ROLLBACK_FAILED",
          "The package allocation transaction and its rollback both failed",
          {
            primaryCode: errorCodeForContext(primaryError),
            rollbackPostgresCode: pgErrorCode(rollbackError),
          },
          new AggregateError([primaryError, rollbackError]),
        );
      }
    }
    let releaseError: unknown = null;
    try {
      client.release(clientDiscardError);
    } catch (error) {
      releaseError = error;
    }
    if (releaseError !== null) {
      const errors = primaryError === null
        ? [releaseError]
        : [primaryError, releaseError];
      throw new PackageAllocationLedgerRepositoryError(
        "RELEASE_FAILED",
        primaryError === null
          ? "The package allocation transaction committed but client release failed"
          : "The package allocation transaction and client release both failed",
        {
          primaryCode: errorCodeForContext(primaryError),
          releaseCode: errorCodeForContext(releaseError),
        },
        new AggregateError(errors),
      );
    }
    if (primaryError !== null) throw primaryError;
    return result as T;
  }
}
