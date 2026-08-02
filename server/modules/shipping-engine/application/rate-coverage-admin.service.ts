import type { AuditLogPayload } from "../../../infrastructure/auditLogger";
import type {
  RateCoverageCandidate,
  RateCoverageDestination,
} from "../domain/rate-coverage";

export interface DestinationScopeRecord {
  id: number;
  name: string;
  status: "draft" | "active" | "retired";
  lockVersion: number;
  destinations: RateCoverageDestination[];
}

export interface RateBookDestinationGroupRecord {
  id: number;
  rateBookId: number;
  sourceDestinationScopeId: number | null;
  sourceDestinationScopeLockVersion: number | null;
  name: string;
  status: "active" | "retired";
  sortOrder: number;
  lockVersion: number;
  destinations: RateCoverageDestination[];
}

export interface RateTableCoverageRecord extends RateCoverageCandidate {
  id: number;
  rateTableId: number;
  destinationGroupId: number;
  destinationGroupLockVersion: number;
  sourceDestinationScopeId: number | null;
  sourceDestinationScopeLockVersion: number | null;
  destinationGroupName: string;
  sortOrder: number;
  rateRowCount: number;
}

export interface DraftRateCoverageGroup extends RateCoverageCandidate {
  destinationGroupId: number | null;
  destinationGroupLockVersion: number | null;
  sourceDestinationScopeId: number | null;
  sourceDestinationScopeLockVersion: number | null;
  sortOrder: number;
}

export interface SavedRateCoverageGroup extends DraftRateCoverageGroup {
  destinationGroupId: number;
  destinationGroupLockVersion: number;
  sourceDestinationScopeId: number;
  sourceDestinationScopeLockVersion: number;
  name: string;
}

export interface RateCoverageAdminTransaction {
  getDestinationScopeForUpdate(
    destinationScopeId: number,
  ): Promise<DestinationScopeRecord | null>;
  getDestinationGroupForUpdate(
    destinationGroupId: number,
  ): Promise<RateBookDestinationGroupRecord | null>;
  findActiveDestinationGroupByScope(
    rateBookId: number,
    destinationScopeId: number,
  ): Promise<RateBookDestinationGroupRecord | null>;
  insertDestinationGroup(input: {
    rateBookId: number;
    sourceDestinationScopeId: number;
    sourceDestinationScopeLockVersion: number;
    name: string;
    sortOrder: number;
    actor: string;
    now: Date;
    destinations: readonly RateCoverageDestination[];
  }): Promise<RateBookDestinationGroupRecord>;
  updateDestinationGroup(input: {
    destinationGroupId: number;
    expectedLockVersion: number;
    sourceDestinationScopeId: number;
    sourceDestinationScopeLockVersion: number;
    name: string;
    sortOrder: number;
    now: Date;
    destinations: readonly RateCoverageDestination[];
  }): Promise<RateBookDestinationGroupRecord | null>;
  loadRateTableCoverages(
    rateTableId: number,
  ): Promise<RateTableCoverageRecord[]>;
  replaceRateTableCoverages(input: {
    rateTableId: number;
    groups: readonly SavedRateCoverageGroup[];
  }): Promise<RateTableCoverageRecord[]>;
  persistAudit(payload: AuditLogPayload, now: Date): Promise<void>;
}

export interface SaveRateCoverageManifestInput {
  rateBookId: number;
  rateTableId: number;
  groups: readonly DraftRateCoverageGroup[];
  actor: string;
  now: Date;
}

export interface SaveRateCoverageManifestResult {
  groups: SavedRateCoverageGroup[];
  coverages: RateTableCoverageRecord[];
}

export class RateCoverageAdminError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: readonly string[] = [],
  ) {
    super(message);
    this.name = "RateCoverageAdminError";
  }
}

/**
 * Synchronizes editor destination groups with their pricing-program identities,
 * then atomically replaces one draft revision's frozen coverage manifest.
 */
export async function saveRateCoverageManifest(
  tx: RateCoverageAdminTransaction,
  input: SaveRateCoverageManifestInput,
): Promise<SaveRateCoverageManifestResult> {
  const before = await tx.loadRateTableCoverages(input.rateTableId);
  const normalizedGroups = input.groups.map(normalizeDraftGroup);
  assertConsistentDestinationGroupDefinitions(normalizedGroups);
  const savedGroups: SavedRateCoverageGroup[] = [];
  const persistedByIdentity = new Map<
    string,
    RateBookDestinationGroupRecord
  >();
  const persistedById = new Map<number, RateBookDestinationGroupRecord>();

  for (const normalized of normalizedGroups) {
    const identityKey = draftIdentityKey(normalized);
    let persisted = persistedByIdentity.get(identityKey);
    if (
      persisted === undefined
      && normalized.destinationGroupId !== null
    ) {
      persisted = persistedById.get(normalized.destinationGroupId);
    }
    if (persisted === undefined) {
      persisted = normalized.destinationGroupId === null
        ? await resolveOrCreateDestinationGroup(tx, input, normalized)
        : await updateExistingDestinationGroup(tx, input, {
            ...normalized,
            destinationGroupId: normalized.destinationGroupId,
          });
      persistedByIdentity.set(identityKey, persisted);
      persistedById.set(persisted.id, persisted);
    }

    assertLinkedDestinationGroup(persisted);
    savedGroups.push({
      ...normalized,
      destinationGroupId: persisted.id,
      destinationGroupLockVersion: persisted.lockVersion,
      sourceDestinationScopeId: persisted.sourceDestinationScopeId,
      sourceDestinationScopeLockVersion:
        persisted.sourceDestinationScopeLockVersion,
      name: persisted.name,
      destinations: persisted.destinations,
    });
  }

  const duplicateScopes = findDuplicateCoverageScopes(savedGroups);
  if (duplicateScopes.length > 0) {
    throw new RateCoverageAdminError(
      409,
      "SHIPPING_ADMIN_DESTINATION_GROUP_SCOPE_CONFLICT",
      "A destination group can have only one configuration per warehouse scope.",
      duplicateScopes,
    );
  }

  const coverages = await tx.replaceRateTableCoverages({
    rateTableId: input.rateTableId,
    groups: savedGroups,
  });

  await tx.persistAudit({
    actor: input.actor,
    action: "shipping.rate_table_coverage.saved",
    target: `shipping.rate_tables:${input.rateTableId}`,
    changes: {
      before: { coverages: auditCoverageState(before) },
      after: { coverages: auditCoverageState(coverages) },
    },
    context: {
      rateBookId: input.rateBookId,
      destinationGroupCount: savedGroups.length,
    },
  }, input.now);

  return { groups: savedGroups, coverages };
}

async function resolveOrCreateDestinationGroup(
  tx: RateCoverageAdminTransaction,
  input: SaveRateCoverageManifestInput,
  group: DraftRateCoverageGroup,
): Promise<RateBookDestinationGroupRecord> {
  const scope = await loadCanonicalScope(tx, group);
  const existing = await tx.findActiveDestinationGroupByScope(
    input.rateBookId,
    scope.id,
  );
  if (existing !== null) {
    const unchanged = existing.sourceDestinationScopeLockVersion === scope.lockVersion
      && existing.name === scope.name
      && existing.sortOrder === group.sortOrder
      && sameDestinations(existing.destinations, scope.destinations);
    if (unchanged) return existing;
    const updated = await tx.updateDestinationGroup({
      destinationGroupId: existing.id,
      expectedLockVersion: existing.lockVersion,
      sourceDestinationScopeId: scope.id,
      sourceDestinationScopeLockVersion: scope.lockVersion,
      name: scope.name,
      sortOrder: group.sortOrder,
      now: input.now,
      destinations: scope.destinations,
    });
    if (updated === null) {
      throw destinationGroupChanged(existing.name);
    }
    return updated;
  }

  return tx.insertDestinationGroup({
    rateBookId: input.rateBookId,
    sourceDestinationScopeId: scope.id,
    sourceDestinationScopeLockVersion: scope.lockVersion,
    name: scope.name,
    sortOrder: group.sortOrder,
    actor: input.actor,
    now: input.now,
    destinations: scope.destinations,
  });
}

async function updateExistingDestinationGroup(
  tx: RateCoverageAdminTransaction,
  input: SaveRateCoverageManifestInput,
  group: DraftRateCoverageGroup & { destinationGroupId: number },
): Promise<RateBookDestinationGroupRecord> {
  const existing = await tx.getDestinationGroupForUpdate(group.destinationGroupId);
  if (
    existing === null
    || existing.rateBookId !== input.rateBookId
    || existing.status !== "active"
  ) {
    throw destinationGroupChanged(group.name);
  }
  const sourceAwareGroup = group.sourceDestinationScopeId === null
    && group.sourceDestinationScopeLockVersion === null
    && existing.sourceDestinationScopeId !== null
    && existing.sourceDestinationScopeLockVersion !== null
    ? {
        ...group,
        sourceDestinationScopeId: existing.sourceDestinationScopeId,
        sourceDestinationScopeLockVersion:
          existing.sourceDestinationScopeLockVersion,
      }
    : group;
  const scope = await loadCanonicalScope(tx, sourceAwareGroup);
  if (
    existing.sourceDestinationScopeId !== null
    && existing.sourceDestinationScopeId !== scope.id
  ) {
    throw new RateCoverageAdminError(
      409,
      "SHIPPING_ADMIN_DESTINATION_SCOPE_SOURCE_CHANGED",
      `${existing.name} belongs to a different destination scope.`,
      ["Add the intended destination scope as a new pricing configuration."],
    );
  }

  const changed = existing.sourceDestinationScopeId !== scope.id
    || existing.sourceDestinationScopeLockVersion !== scope.lockVersion
    || existing.name !== scope.name
    || existing.sortOrder !== group.sortOrder
    || !sameDestinations(existing.destinations, scope.destinations);
  if (!changed) return existing;

  if (
    group.destinationGroupLockVersion === null
    || group.destinationGroupLockVersion !== existing.lockVersion
  ) {
    throw destinationGroupChanged(existing.name);
  }

  const updated = await tx.updateDestinationGroup({
    destinationGroupId: existing.id,
    expectedLockVersion: existing.lockVersion,
    sourceDestinationScopeId: scope.id,
    sourceDestinationScopeLockVersion: scope.lockVersion,
    name: scope.name,
    sortOrder: group.sortOrder,
    now: input.now,
    destinations: scope.destinations,
  });
  if (updated === null) {
    throw destinationGroupChanged(existing.name);
  }
  return updated;
}

async function loadCanonicalScope(
  tx: RateCoverageAdminTransaction,
  group: DraftRateCoverageGroup,
): Promise<DestinationScopeRecord> {
  if (
    group.sourceDestinationScopeId === null
    || group.sourceDestinationScopeLockVersion === null
  ) {
    throw new RateCoverageAdminError(
      400,
      "SHIPPING_ADMIN_DESTINATION_SCOPE_REQUIRED",
      "Every pricing destination must come from the destination library.",
    );
  }
  const scope = await tx.getDestinationScopeForUpdate(
    group.sourceDestinationScopeId,
  );
  if (scope === null || scope.status !== "active") {
    throw new RateCoverageAdminError(
      409,
      "SHIPPING_ADMIN_DESTINATION_SCOPE_NOT_ACTIVE",
      `${group.name} is no longer an active destination scope.`,
    );
  }
  if (scope.lockVersion !== group.sourceDestinationScopeLockVersion) {
    throw new RateCoverageAdminError(
      409,
      "SHIPPING_ADMIN_DESTINATION_SCOPE_CHANGED",
      `${scope.name} changed after this editor was opened.`,
      ["Review and use the current destination definition before saving."],
    );
  }
  if (
    scope.name !== group.name
    || !sameDestinations(scope.destinations, group.destinations)
  ) {
    throw new RateCoverageAdminError(
      409,
      "SHIPPING_ADMIN_DESTINATION_SCOPE_MISMATCH",
      `${scope.name} does not match the submitted destination snapshot.`,
      ["Reload the destination library before saving."],
    );
  }
  return scope;
}

function assertLinkedDestinationGroup(
  group: RateBookDestinationGroupRecord,
): asserts group is RateBookDestinationGroupRecord & {
  sourceDestinationScopeId: number;
  sourceDestinationScopeLockVersion: number;
} {
  if (
    group.sourceDestinationScopeId === null
    || group.sourceDestinationScopeLockVersion === null
  ) {
    throw new RateCoverageAdminError(
      500,
      "SHIPPING_ADMIN_DESTINATION_SCOPE_LINK_MISSING",
      `${group.name} was saved without a canonical destination scope.`,
    );
  }
}

function destinationGroupChanged(name: string): RateCoverageAdminError {
  return new RateCoverageAdminError(
    409,
    "SHIPPING_ADMIN_DESTINATION_GROUP_CHANGED",
    `${name} changed after this editor was opened. Refresh before saving.`,
  );
}

function normalizeDraftGroup(group: DraftRateCoverageGroup): DraftRateCoverageGroup {
  const name = group.name.trim();
  if (name === "") {
    throw new RateCoverageAdminError(
      400,
      "SHIPPING_ADMIN_DESTINATION_GROUP_NAME_REQUIRED",
      "Every destination group needs a name.",
    );
  }
  return {
    ...group,
    name,
    destinations: normalizeDestinations(group.destinations),
  };
}

function assertConsistentDestinationGroupDefinitions(
  groups: readonly DraftRateCoverageGroup[],
): void {
  const definitions = new Map<string, DraftRateCoverageGroup>();
  for (const group of groups) {
    const key = draftIdentityKey(group);
    const existing = definitions.get(key);
    if (existing === undefined) {
      definitions.set(key, group);
      continue;
    }
    const sameName = existing.name.toLocaleLowerCase()
      === group.name.toLocaleLowerCase();
    const sameVersion = existing.destinationGroupLockVersion === null
      || group.destinationGroupLockVersion === null
      || existing.destinationGroupLockVersion
        === group.destinationGroupLockVersion;
    const sameSource = existing.sourceDestinationScopeId
      === group.sourceDestinationScopeId;
    const sameSourceVersion = existing.sourceDestinationScopeLockVersion
      === group.sourceDestinationScopeLockVersion;
    if (
      sameName
      && sameVersion
      && sameSource
      && sameSourceVersion
      && sameDestinations(existing.destinations, group.destinations)
    ) {
      continue;
    }
    throw new RateCoverageAdminError(
      409,
      "SHIPPING_ADMIN_DESTINATION_GROUP_DEFINITION_CONFLICT",
      `${existing.name} has conflicting geography definitions in this draft.`,
      [
        "Every warehouse scope for a destination group must use the same "
          + "name, version, and destinations.",
      ],
    );
  }
}

function draftIdentityKey(group: DraftRateCoverageGroup): string {
  if (group.destinationGroupId !== null) {
    return `id:${group.destinationGroupId}`;
  }
  return group.sourceDestinationScopeId === null
    ? `unlinked:${group.name.toLocaleLowerCase()}`
    : `scope:${group.sourceDestinationScopeId}`;
}

function normalizeDestinations(
  destinations: readonly RateCoverageDestination[],
): RateCoverageDestination[] {
  const normalized = destinations.map((destination) => ({
    destinationCountry: destination.destinationCountry.trim().toUpperCase(),
    destinationRegion:
      destination.destinationRegion?.trim().toUpperCase() || null,
    postalPrefix: destination.postalPrefix?.trim().toUpperCase() || null,
  }));
  return [...new Map(
    normalized.map((destination) => [destinationKey(destination), destination]),
  ).values()].sort((left, right) =>
    destinationKey(left).localeCompare(destinationKey(right)));
}

function sameDestinations(
  left: readonly RateCoverageDestination[],
  right: readonly RateCoverageDestination[],
): boolean {
  const leftKeys = normalizeDestinations(left).map(destinationKey);
  const rightKeys = normalizeDestinations(right).map(destinationKey);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]);
}

function destinationKey(destination: RateCoverageDestination): string {
  return [
    destination.destinationCountry,
    destination.destinationRegion ?? "",
    destination.postalPrefix ?? "",
  ].join("|");
}

function findDuplicateCoverageScopes(
  groups: readonly SavedRateCoverageGroup[],
): string[] {
  const scopes = new Map<string, SavedRateCoverageGroup[]>();
  for (const group of groups) {
    const key = [
      group.destinationGroupId,
      group.originWarehouseId ?? 0,
    ].join("|");
    scopes.set(key, [...(scopes.get(key) ?? []), group]);
  }
  return [...scopes.values()]
    .filter((items) => items.length > 1)
    .map((items) => {
      const group = items[0];
      const warehouse = group.originWarehouseId === null
        ? "all warehouses"
        : `warehouse ${group.originWarehouseId}`;
      return `${group.name} is configured more than once for ${warehouse}.`;
    });
}

function auditCoverageState(
  coverages: readonly RateTableCoverageRecord[],
): Array<Record<string, unknown>> {
  return coverages.map((coverage) => ({
    destinationGroupId: coverage.destinationGroupId,
    destinationGroupLockVersion: coverage.destinationGroupLockVersion,
    destinationGroupName: coverage.destinationGroupName,
    sourceDestinationScopeId: coverage.sourceDestinationScopeId,
    sourceDestinationScopeLockVersion: coverage.sourceDestinationScopeLockVersion,
    originWarehouseId: coverage.originWarehouseId,
    availability: coverage.availability,
    destinations: coverage.destinations,
  }));
}
