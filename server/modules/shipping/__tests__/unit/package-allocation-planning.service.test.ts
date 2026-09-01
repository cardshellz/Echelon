import { describe, expect, it } from "vitest";

import type {
  PackageAllocationEffectIntentV1,
  PackageAllocationEntryV1,
  PackageAllocationGroupPackageEvidenceV1,
} from "../../package-allocation-group.domain";
import {
  PackageAllocationLedgerRepositoryError,
} from "../../package-allocation-ledger.repository";
import type {
  AppendPackageAllocationPlanInput,
  LockedPackageAllocationGroup,
  PackageAllocationLedgerRepository,
  PackageAllocationLedgerTransaction,
  PersistedPackageAllocationEntry,
  PersistedPackageAllocationEffectOutboxEntry,
  PersistedPackageAllocationIntent,
  PersistedPackageAllocationPlan,
  RegisteredPackageAllocationBinding,
  RegisteredPackageAllocationSource,
} from "../../package-allocation-ledger.repository";
import {
  PACKAGE_ALLOCATION_PLANNER_VERSION,
  PackageAllocationPersistenceError,
  PackageAllocationPlanningService,
  type PersistPackageAllocationPlanCommand,
} from "../../package-allocation-planning.service";
import { buildPackageAllocationAuthorityRelationshipSelectionEvidence } from "../../package-allocation-authority-resolution.service";
import {
  derivePackageAllocationSourceRegistration,
  type PackageAllocationSourceFacts,
  type PackageAllocationSourceRegistrationV1,
} from "../../package-allocation-source-identity.domain";

const groupKey = "86e1be0d-c7d8-4c91-919f-04f5eb547f79";

function sourceFacts(
  overrides: Partial<PackageAllocationSourceFacts> = {},
): PackageAllocationSourceFacts {
  return {
    sourceWmsShipmentItemId: 7001,
    shipmentRequestItemId: "90001",
    sourceQuantity: 2,
    shipmentItemPurpose: "customer_fulfillment",
    orderItemId: 8101,
    replacementForOrderItemId: null,
    correctionForShipmentItemId: null,
    productVariantId: 9101,
    orderItemSku: "SKU-ONE",
    replacementOrderItemSku: null,
    productVariantSku: "SKU-ONE",
    ...overrides,
  };
}

function command(
  overrides: Partial<PersistPackageAllocationPlanCommand> = {},
): PersistPackageAllocationPlanCommand {
  return {
    contractVersion: 1,
    authorityMode: "shadow_only",
    groupKey,
    expectedGroupVersion: 0,
    sourceLines: [{
      wmsShipmentItemId: 7001,
      sourceQuantity: 2,
      physicalConsumptionAuthorityQuantity: 2,
      authorityVersion: 1,
    }],
    packages: [{
      packageKey: "A",
      allocationRole: "primary",
      membership: { status: "proven", evidenceKey: "membership:A" },
      lifecycle: {
        provider: "shipstation",
        providerPhysicalShipmentId: "44001",
        events: [{
          kind: "outbound_label_observed",
          eventKey: "shipstation:44001:observed",
          observedAt: "2026-08-21T14:00:00.000Z",
          providerOccurredAt: "2026-08-21T13:59:50.000Z",
          trackingNumber: "1Z0000000000044001",
          contentsEvidence: {
            status: "authoritative",
            lines: [{ wmsShipmentItemId: 7001, quantity: 2 }],
          },
        }],
      },
    }],
    actions: [],
    writeContext: {
      createdBy: "shipment-lifecycle-shadow",
      reason: "Persist deterministic package allocation evidence",
    },
    ...overrides,
  };
}

function persistedEntry(entry: PackageAllocationEntryV1): PersistedPackageAllocationEntry {
  return Object.freeze({
    entryKey: entry.entryKey,
    allocationKey: entry.allocationKey,
    sourceWmsShipmentItemId: entry.wmsShipmentItemId,
    allocationKind: entry.allocationKind,
    targetKind: entry.targetKind,
    packageKey: entry.packageKey,
    shippingProviderLabelId: null,
    quantity: entry.quantity,
  });
}

function persistedIntent(intent: PackageAllocationEffectIntentV1): PersistedPackageAllocationIntent {
  return Object.freeze({
    intentKey: intent.intentKey,
    effectType: intent.effectType,
    payloadHash: intent.payloadHash,
    sourceWmsShipmentItemId: intent.wmsShipmentItemId,
    packageKey: intent.packageKey,
    shippingProviderLabelId: null,
    quantity: intent.quantity,
    payload: Object.freeze({
      effectType: intent.effectType,
      subjectKey: intent.subjectKey,
      wmsShipmentItemId: intent.wmsShipmentItemId,
      packageKey: intent.packageKey,
      quantity: intent.quantity,
    }),
    executable: false,
  });
}

function persistedEffectOutbox(
  intent: PackageAllocationEffectIntentV1,
): PersistedPackageAllocationEffectOutboxEntry {
  return Object.freeze({
    intentKey: intent.intentKey,
    idempotencyKey: intent.intentKey,
    payloadHash: intent.payloadHash,
    state: "shadow",
    executionEnabled: false,
    attemptCount: 0,
  });
}

class InMemoryLedgerTransaction implements PackageAllocationLedgerTransaction {
  group: LockedPackageAllocationGroup | null = null;
  readonly plansByVersion = new Map<number, PersistedPackageAllocationPlan>();
  readonly entriesByPlan = new Map<string, readonly PersistedPackageAllocationEntry[]>();
  readonly intentsByPlan = new Map<string, readonly PersistedPackageAllocationIntent[]>();
  readonly effectOutboxByPlan = new Map<
    string,
    readonly PersistedPackageAllocationEffectOutboxEntry[]
  >();
  readonly sources = new Map<number, RegisteredPackageAllocationSource>();
  readonly bindings = new Map<string, RegisteredPackageAllocationBinding>();
  appendCalls: AppendPackageAllocationPlanInput[] = [];
  facts: readonly PackageAllocationSourceFacts[] = [sourceFacts()];

  async lockGroup(
    requestedGroupKey: string,
    createIfMissing: boolean,
  ): Promise<LockedPackageAllocationGroup | null> {
    if (this.group === null && createIfMissing) {
      this.group = Object.freeze({ id: "1", groupKey: requestedGroupKey, currentVersion: 0 });
    }
    return this.group;
  }

  async lockSourceFacts(): Promise<readonly PackageAllocationSourceFacts[]> {
    return this.facts;
  }

  async ensureSourceRegistrations(
    _group: LockedPackageAllocationGroup,
    registrations: readonly PackageAllocationSourceRegistrationV1[],
    allowCreate: boolean,
  ): Promise<ReadonlyMap<number, RegisteredPackageAllocationSource>> {
    for (const registration of registrations) {
      if (!this.sources.has(registration.sourceWmsShipmentItemId) && allowCreate) {
        this.sources.set(registration.sourceWmsShipmentItemId, Object.freeze({
          id: String(10 + registration.sourceWmsShipmentItemId),
          registration,
        }));
      }
      if (!this.sources.has(registration.sourceWmsShipmentItemId)) {
        throw new Error("source registration missing");
      }
    }
    return this.sources;
  }

  async ensurePackageBindings(
    _group: LockedPackageAllocationGroup,
    packages: readonly PackageAllocationGroupPackageEvidenceV1[],
    allowCreate: boolean,
  ): Promise<ReadonlyMap<string, RegisteredPackageAllocationBinding>> {
    for (const pkg of packages) {
      if (!this.bindings.has(pkg.packageKey) && allowCreate) {
        this.bindings.set(pkg.packageKey, Object.freeze({
          id: String(20 + this.bindings.size),
          packageKey: pkg.packageKey,
          provider: pkg.provider,
          providerPhysicalShipmentId: pkg.providerPhysicalShipmentId,
          identityHash: pkg.identityHash,
        }));
      }
      if (!this.bindings.has(pkg.packageKey)) throw new Error("package binding missing");
    }
    return this.bindings;
  }

  async loadPlanByVersion(
    _groupId: string,
    planVersion: number,
  ): Promise<PersistedPackageAllocationPlan | null> {
    return this.plansByVersion.get(planVersion) ?? null;
  }

  async loadPlanByInputHash(
    _groupId: string,
    inputHash: string,
  ): Promise<PersistedPackageAllocationPlan | null> {
    return [...this.plansByVersion.values()].find((plan) => plan.inputHash === inputHash) ?? null;
  }

  async loadPlanEntries(planId: string): Promise<readonly PersistedPackageAllocationEntry[]> {
    return this.entriesByPlan.get(planId) ?? [];
  }

  async loadPlanIntents(planId: string): Promise<readonly PersistedPackageAllocationIntent[]> {
    return this.intentsByPlan.get(planId) ?? [];
  }

  async loadPlanEffectOutbox(
    planId: string,
  ): Promise<readonly PersistedPackageAllocationEffectOutboxEntry[]> {
    return this.effectOutboxByPlan.get(planId) ?? [];
  }

  async appendPlan(input: AppendPackageAllocationPlanInput): Promise<string> {
    this.appendCalls.push(input);
    const planId = String(100 + input.planVersion);
    const plan: PersistedPackageAllocationPlan = Object.freeze({
      id: planId,
      packageAllocationGroupId: input.group.id,
      planVersion: input.planVersion,
      expectedGroupVersion: input.group.currentVersion,
      inputHash: input.inputHash,
      stateHash: input.stateHash,
      outcome: input.outcome,
      plannerVersion: input.plannerVersion,
      reason: input.reason,
      createdBy: input.createdBy,
      authoritySnapshot: structuredClone(input.authoritySnapshot),
      stateSnapshot: structuredClone(input.stateSnapshot),
      reviewSnapshot: structuredClone(input.reviewSnapshot),
    });
    this.plansByVersion.set(plan.planVersion, plan);
    this.entriesByPlan.set(planId, Object.freeze(input.entries.map(persistedEntry)));
    this.intentsByPlan.set(planId, Object.freeze(input.intents.map(persistedIntent)));
    this.effectOutboxByPlan.set(
      planId,
      Object.freeze(input.intents.map(persistedEffectOutbox)),
    );
    this.group = Object.freeze({
      ...input.group,
      currentVersion: input.planVersion,
    });
    return planId;
  }
}

class InMemoryLedgerRepository implements PackageAllocationLedgerRepository {
  readonly transaction = new InMemoryLedgerTransaction();
  transactionCalls = 0;

  async withSerializableTransaction<T>(
    work: (transaction: PackageAllocationLedgerTransaction) => Promise<T>,
  ): Promise<T> {
    this.transactionCalls += 1;
    return work(this.transaction);
  }
}

class ConflictThenSuccessRepository extends InMemoryLedgerRepository {
  attempts = 0;

  constructor(private readonly conflictsBeforeSuccess: number) {
    super();
  }

  override async withSerializableTransaction<T>(
    work: (transaction: PackageAllocationLedgerTransaction) => Promise<T>,
  ): Promise<T> {
    this.attempts += 1;
    if (this.attempts <= this.conflictsBeforeSuccess) {
      throw new PackageAllocationLedgerRepositoryError(
        "CONCURRENT_WRITE",
        "synthetic serialization conflict",
      );
    }
    return work(this.transaction);
  }
}

function expectPersistenceError(
  error: unknown,
  code: PackageAllocationPersistenceError["code"],
): void {
  expect(error).toBeInstanceOf(PackageAllocationPersistenceError);
  expect((error as PackageAllocationPersistenceError).code).toBe(code);
}

describe("PackageAllocationPlanningService", () => {
  it("reruns the planner under the locked transaction and persists one inert plan", async () => {
    const repository = new InMemoryLedgerRepository();
    const service = new PackageAllocationPlanningService(repository);

    const result = await service.persist(command());

    expect(result).toMatchObject({
      kind: "created",
      groupId: "1",
      planId: "101",
      persistedPlanVersion: 1,
      currentGroupVersion: 1,
    });
    expect(repository.transaction.appendCalls).toHaveLength(1);
    const persisted = repository.transaction.appendCalls[0];
    expect(persisted.entries).toEqual(result.plannerResult.ledgerEntriesToAppend);
    expect(persisted.intents).toEqual(result.plannerResult.effectIntentsToAppend);
    expect(persisted.intents.every((intent) => intent.executable === false)).toBe(true);
    expect(repository.transaction.effectOutboxByPlan.get("101")).toEqual(
      result.plannerResult.effectIntentsToAppend.map(persistedEffectOutbox),
    );
    expect(persisted.plannerVersion).toBe("package-allocation-group-v2");
    expect(persisted.plannerVersion).toBe(PACKAGE_ALLOCATION_PLANNER_VERSION);
    expect(persisted.stateSnapshot).toEqual(result.plannerResult.state);
  });

  it("returns an exact replay without appending another plan", async () => {
    const repository = new InMemoryLedgerRepository();
    const service = new PackageAllocationPlanningService(repository);
    await service.persist(command());

    const replay = await service.persist(command());

    expect(replay).toMatchObject({
      kind: "already_persisted",
      planId: "101",
      persistedPlanVersion: 1,
      currentGroupVersion: 1,
    });
    expect(repository.transaction.appendCalls).toHaveLength(1);
  });

  it("treats an identical current projection as unchanged and writes nothing", async () => {
    const repository = new InMemoryLedgerRepository();
    const service = new PackageAllocationPlanningService(repository);
    await service.persist(command());

    const unchanged = await service.persist(command({ expectedGroupVersion: 1 }));

    expect(unchanged).toMatchObject({
      kind: "unchanged",
      planId: "101",
      persistedPlanVersion: 1,
      currentGroupVersion: 1,
    });
    expect(unchanged.plannerResult.outcome).toBe("unchanged");
    expect(repository.transaction.appendCalls).toHaveLength(1);
  });

  it("rejects a stale changed result before appending", async () => {
    const repository = new InMemoryLedgerRepository();
    const service = new PackageAllocationPlanningService(repository);
    await service.persist(command());
    const changed = command();
    changed.packages[0].lifecycle.events.push({
      kind: "outbound_label_reprinted",
      eventKey: "shipstation:44001:reprint:1",
      observedAt: "2026-08-21T14:02:00.000Z",
      providerOccurredAt: null,
      trackingNumber: "1Z0000000000044001",
    });

    await expect(service.persist(changed)).rejects.toSatisfy((error: unknown) => {
      expectPersistenceError(error, "STALE_GROUP_VERSION");
      return true;
    });
    expect(repository.transaction.appendCalls).toHaveLength(1);
  });

  it("rejects locked WMS quantity evidence that conflicts with planner input", async () => {
    const repository = new InMemoryLedgerRepository();
    repository.transaction.facts = [sourceFacts({ sourceQuantity: 3 })];
    const service = new PackageAllocationPlanningService(repository);

    await expect(service.persist(command())).rejects.toSatisfy((error: unknown) => {
      expectPersistenceError(error, "SOURCE_EVIDENCE_CONFLICT");
      return true;
    });
    expect(repository.transaction.appendCalls).toHaveLength(0);
  });

  it("rejects a corrupted persisted base snapshot before planning", async () => {
    const repository = new InMemoryLedgerRepository();
    repository.transaction.group = Object.freeze({ id: "1", groupKey, currentVersion: 1 });
    repository.transaction.plansByVersion.set(1, Object.freeze({
      id: "101",
      packageAllocationGroupId: "1",
      planVersion: 1,
      expectedGroupVersion: 0,
      inputHash: "a".repeat(64),
      stateHash: "b".repeat(64),
      outcome: "proposed",
      plannerVersion: PACKAGE_ALLOCATION_PLANNER_VERSION,
      reason: "test",
      createdBy: "test",
      authoritySnapshot: {
        contractVersion: 1,
        authorityMode: "shadow_only",
        selectionAuthority: "caller_supplied_unproven",
        selectionCompleteness: "unproven_caller_selection",
      },
      stateSnapshot: { actionEvidence: [] },
      reviewSnapshot: { contractVersion: 1, reviews: [] },
    }));
    const service = new PackageAllocationPlanningService(repository);

    await expect(service.persist(command({ expectedGroupVersion: 1 }))).rejects.toSatisfy(
      (error: unknown) => {
        expectPersistenceError(error, "PERSISTED_STATE_INVALID");
        return true;
      },
    );
  });

  it("rejects malformed persisted evidence elements as database-state corruption", async () => {
    const repository = new InMemoryLedgerRepository();
    const service = new PackageAllocationPlanningService(repository);
    await service.persist(command());
    const plan = repository.transaction.plansByVersion.get(1)!;
    const state = structuredClone(plan.stateSnapshot) as Record<string, unknown>;
    state.actionEvidence = [{ bad: true }];
    repository.transaction.plansByVersion.set(1, Object.freeze({
      ...plan,
      stateSnapshot: state,
    }));

    await expect(service.persist(command({ expectedGroupVersion: 1 }))).rejects.toSatisfy(
      (error: unknown) => {
        expectPersistenceError(error, "PERSISTED_STATE_INVALID");
        expect((error as PackageAllocationPersistenceError).context).toHaveProperty("issues");
        return true;
      },
    );
    expect(repository.transaction.appendCalls).toHaveLength(1);
  });

  it("rejects malformed persisted authority provenance as database-state corruption", async () => {
    const repository = new InMemoryLedgerRepository();
    const service = new PackageAllocationPlanningService(repository);
    await service.persist(command());
    const plan = repository.transaction.plansByVersion.get(1)!;
    repository.transaction.plansByVersion.set(1, Object.freeze({
      ...plan,
      authoritySnapshot: { selectionAuthority: "unknown" },
    }));

    await expect(service.persist(command({ expectedGroupVersion: 1 }))).rejects.toSatisfy(
      (error: unknown) => {
        expectPersistenceError(error, "PERSISTED_STATE_INVALID");
        expect((error as PackageAllocationPersistenceError).context).toMatchObject({
          planId: "101",
          planVersion: 1,
        });
        return true;
      },
    );
    expect(repository.transaction.appendCalls).toHaveLength(1);
  });

  it("fails closed when a persisted v1 plan is loaded by the v2 planner", async () => {
    const repository = new InMemoryLedgerRepository();
    const service = new PackageAllocationPlanningService(repository);
    await service.persist(command());
    const plan = repository.transaction.plansByVersion.get(1)!;
    repository.transaction.plansByVersion.set(1, Object.freeze({
      ...plan,
      plannerVersion: "package-allocation-group-v1",
    }));

    await expect(service.persist(command({ expectedGroupVersion: 1 }))).rejects.toSatisfy(
      (error: unknown) => {
        expectPersistenceError(error, "PERSISTED_STATE_INVALID");
        expect((error as PackageAllocationPersistenceError).context).toMatchObject({
          planId: "101",
          plannerVersion: "package-allocation-group-v1",
          expectedPlannerVersion: "package-allocation-group-v2",
        });
        return true;
      },
    );
    expect(repository.transaction.appendCalls).toHaveLength(1);
  });

  it("rejects an input-hash replay whose persisted graph was changed", async () => {
    const repository = new InMemoryLedgerRepository();
    const service = new PackageAllocationPlanningService(repository);
    await service.persist(command());
    const entries = repository.transaction.entriesByPlan.get("101")!;
    repository.transaction.entriesByPlan.set("101", Object.freeze([
      Object.freeze({ ...entries[0], quantity: entries[0].quantity + 1 }),
      ...entries.slice(1),
    ]));

    await expect(service.persist(command())).rejects.toSatisfy((error: unknown) => {
      expectPersistenceError(error, "REPLAY_CONFLICT");
      return true;
    });
  });

  it("rejects an input-hash replay whose shadow outbox identity was changed", async () => {
    const repository = new InMemoryLedgerRepository();
    const service = new PackageAllocationPlanningService(repository);
    await service.persist(command());
    const outbox = repository.transaction.effectOutboxByPlan.get("101")!;
    repository.transaction.effectOutboxByPlan.set("101", Object.freeze([
      Object.freeze({ ...outbox[0], payloadHash: "f".repeat(64) }),
      ...outbox.slice(1),
    ]));

    await expect(service.persist(command())).rejects.toSatisfy((error: unknown) => {
      expectPersistenceError(error, "REPLAY_CONFLICT");
      return true;
    });
  });

  it("rejects an exact planner replay with different immutable selection provenance", async () => {
    const repository = new InMemoryLedgerRepository();
    const service = new PackageAllocationPlanningService(repository);
    const firstRelationshipEvidence =
      buildPackageAllocationAuthorityRelationshipSelectionEvidence(
        [7001],
        [{
          shippingProviderLabelId: 42,
          relationshipTypes: ["shipping_engine_order_link"],
        }],
      );
    const secondRelationshipEvidence =
      buildPackageAllocationAuthorityRelationshipSelectionEvidence(
        [7001],
        [{
          shippingProviderLabelId: 42,
          relationshipTypes: ["provider_order_id_match"],
        }],
      );
    const mutableEvidence = (
      evidence: typeof firstRelationshipEvidence,
    ) => ({
      contractVersion: evidence.contractVersion,
      evidenceType: evidence.evidenceType,
      evidenceHash: evidence.evidenceHash,
      sourceWmsShipmentItemIds: [...evidence.sourceWmsShipmentItemIds],
      packages: evidence.packages.map((pkg) => ({
        shippingProviderLabelId: pkg.shippingProviderLabelId,
        relationshipTypes: [...pkg.relationshipTypes],
      })),
    });
    const firstAuthority = Object.freeze({
      contractVersion: 1 as const,
      authorityMode: "shadow_only" as const,
      selectionAuthority: "database_relationship_closure" as const,
      selectionCompleteness: "unproven_outside_persisted_relationships" as const,
      relationshipSelectionEvidence: mutableEvidence(firstRelationshipEvidence),
    });
    await repository.withSerializableTransaction((transaction) =>
      service.persistInTransaction(transaction, command(), firstAuthority));

    await expect(repository.withSerializableTransaction((transaction) =>
      service.persistInTransaction(transaction, command(), {
        ...firstAuthority,
        relationshipSelectionEvidence: mutableEvidence(secondRelationshipEvidence),
      }))).rejects.toSatisfy((error: unknown) => {
      expectPersistenceError(error, "REPLAY_CONFLICT");
      return true;
    });
    expect(repository.transaction.appendCalls).toHaveLength(1);
  });

  it("rejects malformed authority provenance before appending a plan", async () => {
    const repository = new InMemoryLedgerRepository();
    const service = new PackageAllocationPlanningService(repository);

    await expect(repository.withSerializableTransaction((transaction) =>
      service.persistInTransaction(transaction, command(), {
        contractVersion: 1,
        authorityMode: "shadow_only",
        selectionAuthority: "database_relationship_closure",
        selectionCompleteness: "unproven_outside_persisted_relationships",
        relationshipSelectionEvidence: {
          contractVersion: 1,
          evidenceType: "package_allocation_relationship_selection",
          evidenceHash: "a".repeat(64),
          sourceWmsShipmentItemIds: [7001],
          packages: [],
        },
      } as any))).rejects.toSatisfy((error: unknown) => {
      expectPersistenceError(error, "INVALID_WRITE_INPUT");
      return true;
    });
    expect(repository.transaction.appendCalls).toHaveLength(0);
  });

  it("retries the whole locked planning transaction after a serialization conflict", async () => {
    const repository = new ConflictThenSuccessRepository(2);
    const service = new PackageAllocationPlanningService(repository);

    const result = await service.persist(command());

    expect(result.kind).toBe("created");
    expect(repository.attempts).toBe(3);
    expect(repository.transaction.appendCalls).toHaveLength(1);
  });

  it("stops after the bounded number of serialization attempts", async () => {
    const repository = new ConflictThenSuccessRepository(3);
    const service = new PackageAllocationPlanningService(repository);

    await expect(service.persist(command())).rejects.toMatchObject({
      name: "PackageAllocationLedgerRepositoryError",
      code: "CONCURRENT_WRITE",
    });
    expect(repository.attempts).toBe(3);
    expect(repository.transaction.appendCalls).toHaveLength(0);
  });

  it("rejects an invalid command before opening a transaction", async () => {
    const repository = new InMemoryLedgerRepository();
    const service = new PackageAllocationPlanningService(repository);

    await expect(service.persist({
      ...command(),
      writeContext: { createdBy: "", reason: "test" },
    })).rejects.toSatisfy((error: unknown) => {
      expectPersistenceError(error, "INVALID_WRITE_INPUT");
      return true;
    });
    expect(repository.transactionCalls).toBe(0);
  });
});
