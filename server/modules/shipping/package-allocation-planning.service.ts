import { createHash } from "node:crypto";

import { canonicalJson } from "@shared/utils/canonical-json";
import { z } from "zod";

import {
  packageAllocationGroupPlannerInputSchema,
  packageAllocationGroupPreviousPlanSchema,
  planPackageAllocationGroup,
  type PackageAllocationEffectIntentV1,
  type PackageAllocationGroupPlannerInput,
  type PackageAllocationGroupPlannerResultV1,
  type PackageAllocationGroupStateV1,
} from "./package-allocation-group.domain";
import {
  PackageAllocationLedgerRepositoryError,
  type PackageAllocationLedgerRepository,
  type PackageAllocationLedgerTransaction,
  type PersistedPackageAllocationEntry,
  type PersistedPackageAllocationIntent,
  type PersistedPackageAllocationPlan,
} from "./package-allocation-ledger.repository";
import {
  derivePackageAllocationSourceRegistration,
  type PackageAllocationSourceRegistrationV1,
} from "./package-allocation-source-identity.domain";

export const PACKAGE_ALLOCATION_PLANNER_VERSION = "package-allocation-group-v2";
const MAX_SERIALIZABLE_ATTEMPTS = 3;

const writeContextSchema = z.object({
  createdBy: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(500),
}).strict();

export const persistPackageAllocationPlanCommandSchema = packageAllocationGroupPlannerInputSchema
  .omit({ previousPlan: true })
  .extend({ writeContext: writeContextSchema })
  .strict();

export type PersistPackageAllocationPlanCommand = z.input<
  typeof persistPackageAllocationPlanCommandSchema
>;

export type PackageAllocationPersistenceErrorCode =
  | "CURRENT_PLAN_MISSING"
  | "INTENT_PAYLOAD_CONFLICT"
  | "INVALID_WRITE_INPUT"
  | "PERSISTED_STATE_INVALID"
  | "REPLAY_CONFLICT"
  | "SOURCE_EVIDENCE_CONFLICT"
  | "STALE_GROUP_VERSION";

export class PackageAllocationPersistenceError extends Error {
  readonly code: PackageAllocationPersistenceErrorCode;
  readonly context: Readonly<Record<string, unknown>>;
  override readonly cause?: unknown;

  constructor(
    code: PackageAllocationPersistenceErrorCode,
    message: string,
    context: Record<string, unknown> = {},
    cause?: unknown,
  ) {
    super(message);
    this.name = "PackageAllocationPersistenceError";
    this.code = code;
    this.context = Object.freeze({ ...context });
    this.cause = cause;
  }
}

export interface PersistPackageAllocationPlanResult {
  readonly kind: "unchanged" | "created" | "already_persisted";
  readonly groupId: string;
  readonly planId: string | null;
  readonly persistedPlanVersion: number;
  readonly currentGroupVersion: number;
  readonly plannerResult: PackageAllocationGroupPlannerResultV1;
}

interface PersistedStateEvidence {
  readonly actionEvidence: PackageAllocationGroupStateV1["actionEvidence"];
  readonly appliedActionKeys: PackageAllocationGroupStateV1["appliedActionKeys"];
  readonly packageEvidence: PackageAllocationGroupStateV1["packageEvidence"];
  readonly sourceEvidence: PackageAllocationGroupStateV1["sourceEvidence"];
  readonly effectIntentEvidence: PackageAllocationGroupStateV1["effectIntentEvidence"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stateEvidenceFromSnapshot(
  plan: PersistedPackageAllocationPlan,
): PersistedStateEvidence {
  if (!isRecord(plan.stateSnapshot)) {
    throw new PackageAllocationPersistenceError(
      "PERSISTED_STATE_INVALID",
      "The persisted package allocation state snapshot is not an object",
      { planId: plan.id, planVersion: plan.planVersion },
    );
  }
  const requiredArrays = [
    "actionEvidence",
    "appliedActionKeys",
    "packageEvidence",
    "sourceEvidence",
    "effectIntentEvidence",
  ] as const;
  for (const field of requiredArrays) {
    if (!Array.isArray(plan.stateSnapshot[field])) {
      throw new PackageAllocationPersistenceError(
        "PERSISTED_STATE_INVALID",
        `The persisted package allocation state is missing ${field}`,
        { planId: plan.id, planVersion: plan.planVersion, field },
      );
    }
  }
  return Object.freeze({
    actionEvidence: plan.stateSnapshot.actionEvidence as PackageAllocationGroupStateV1["actionEvidence"],
    appliedActionKeys: plan.stateSnapshot.appliedActionKeys as PackageAllocationGroupStateV1["appliedActionKeys"],
    packageEvidence: plan.stateSnapshot.packageEvidence as PackageAllocationGroupStateV1["packageEvidence"],
    sourceEvidence: plan.stateSnapshot.sourceEvidence as PackageAllocationGroupStateV1["sourceEvidence"],
    effectIntentEvidence: plan.stateSnapshot.effectIntentEvidence as PackageAllocationGroupStateV1["effectIntentEvidence"],
  });
}

function previousPlanFromPersisted(
  groupKey: string,
  plan: PersistedPackageAllocationPlan | null,
): PackageAllocationGroupPlannerInput["previousPlan"] {
  if (plan === null) return null;
  if (plan.plannerVersion !== PACKAGE_ALLOCATION_PLANNER_VERSION) {
    throw new PackageAllocationPersistenceError(
      "PERSISTED_STATE_INVALID",
      "The persisted package allocation plan uses an unsupported planner version",
      {
        planId: plan.id,
        planVersion: plan.planVersion,
        plannerVersion: plan.plannerVersion,
        expectedPlannerVersion: PACKAGE_ALLOCATION_PLANNER_VERSION,
      },
    );
  }
  const evidence = stateEvidenceFromSnapshot(plan);
  const parsed = packageAllocationGroupPreviousPlanSchema.safeParse({
    groupKey,
    groupVersion: plan.planVersion,
    stateHash: plan.stateHash,
    ...evidence,
  });
  if (!parsed.success) {
    throw new PackageAllocationPersistenceError(
      "PERSISTED_STATE_INVALID",
      "The persisted package allocation plan evidence is invalid",
      {
        planId: plan.id,
        planVersion: plan.planVersion,
        issues: parsed.error.issues,
      },
    );
  }
  return Object.freeze(parsed.data);
}

function intentPayload(intent: PackageAllocationEffectIntentV1): Readonly<Record<string, unknown>> {
  return Object.freeze({
    effectType: intent.effectType,
    subjectKey: intent.subjectKey,
    wmsShipmentItemId: intent.wmsShipmentItemId,
    packageKey: intent.packageKey,
    quantity: intent.quantity,
  });
}

function assertIntentPayloadHash(intent: PackageAllocationEffectIntentV1): void {
  const recomputed = createHash("sha256")
    .update(canonicalJson(intentPayload(intent)))
    .digest("hex");
  if (recomputed === intent.payloadHash) return;
  throw new PackageAllocationPersistenceError(
    "INTENT_PAYLOAD_CONFLICT",
    "A planner effect intent payload does not match its declared hash",
    { intentKey: intent.intentKey },
  );
}

function expectedPersistedEntries(
  result: PackageAllocationGroupPlannerResultV1,
): readonly PersistedPackageAllocationEntry[] {
  return Object.freeze(result.ledgerEntriesToAppend.map((entry) => Object.freeze({
    entryKey: entry.entryKey,
    allocationKey: entry.allocationKey,
    sourceWmsShipmentItemId: entry.wmsShipmentItemId,
    allocationKind: entry.allocationKind,
    targetKind: entry.targetKind,
    packageKey: entry.packageKey,
    shippingProviderLabelId: null,
    quantity: entry.quantity,
  })));
}

function expectedPersistedIntents(
  result: PackageAllocationGroupPlannerResultV1,
): readonly PersistedPackageAllocationIntent[] {
  return Object.freeze(result.effectIntentsToAppend.map((intent) => {
    assertIntentPayloadHash(intent);
    return Object.freeze({
      intentKey: intent.intentKey,
      effectType: intent.effectType,
      payloadHash: intent.payloadHash,
      sourceWmsShipmentItemId: intent.wmsShipmentItemId,
      packageKey: intent.packageKey,
      shippingProviderLabelId: null,
      quantity: intent.quantity,
      payload: intentPayload(intent),
      executable: false,
    });
  }));
}

function compareCanonical(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

async function assertExactReplay(
  transaction: PackageAllocationLedgerTransaction,
  persisted: PersistedPackageAllocationPlan,
  result: PackageAllocationGroupPlannerResultV1,
  writeContext: { readonly createdBy: string; readonly reason: string },
): Promise<void> {
  const expectedReview = { contractVersion: 1 as const, reviews: result.state.reviews };
  const scalarMatch = persisted.planVersion === result.proposedGroupVersion
    && persisted.expectedGroupVersion === result.baseGroupVersion
    && persisted.inputHash === result.evidenceHash
    && persisted.stateHash === result.stateHash
    && persisted.outcome === result.outcome
    && persisted.plannerVersion === PACKAGE_ALLOCATION_PLANNER_VERSION
    && persisted.reason === writeContext.reason
    && persisted.createdBy === writeContext.createdBy;
  const [entries, intents] = await Promise.all([
    transaction.loadPlanEntries(persisted.id),
    transaction.loadPlanIntents(persisted.id),
  ]);
  if (!scalarMatch
      || !compareCanonical(persisted.stateSnapshot, result.state)
      || !compareCanonical(persisted.reviewSnapshot, expectedReview)
      || !compareCanonical(entries, expectedPersistedEntries(result))
      || !compareCanonical(intents, expectedPersistedIntents(result))) {
    throw new PackageAllocationPersistenceError(
      "REPLAY_CONFLICT",
      "The package allocation input hash already exists with different persisted evidence",
      {
        groupKey: result.groupKey,
        inputHash: result.evidenceHash,
        persistedPlanId: persisted.id,
        persistedPlanVersion: persisted.planVersion,
      },
    );
  }
}

function validateSourceQuantities(
  command: z.output<typeof persistPackageAllocationPlanCommandSchema>,
  registrations: readonly PackageAllocationSourceRegistrationV1[],
): void {
  const registrationById = new Map(registrations.map((item) => [
    item.sourceWmsShipmentItemId,
    item,
  ]));
  for (const source of command.sourceLines) {
    const registration = registrationById.get(source.wmsShipmentItemId);
    if (!registration || registration.sourceQuantity !== source.sourceQuantity) {
      throw new PackageAllocationPersistenceError(
        "SOURCE_EVIDENCE_CONFLICT",
        "Planner source quantity does not match the locked WMS shipment item",
        {
          wmsShipmentItemId: source.wmsShipmentItemId,
          plannerSourceQuantity: source.sourceQuantity,
          persistedSourceQuantity: registration?.sourceQuantity ?? null,
        },
      );
    }
  }
}

export class PackageAllocationPlanningService {
  constructor(private readonly repository: PackageAllocationLedgerRepository) {}

  async persist(
    rawCommand: PersistPackageAllocationPlanCommand,
  ): Promise<PersistPackageAllocationPlanResult> {
    const parsed = persistPackageAllocationPlanCommandSchema.safeParse(rawCommand);
    if (!parsed.success) {
      throw new PackageAllocationPersistenceError(
        "INVALID_WRITE_INPUT",
        "The package allocation persistence command is invalid",
        { issues: parsed.error.issues },
      );
    }
    const command = parsed.data;
    let attempt = 1;
    while (true) {
      try {
        return await this.persistOnce(command);
      } catch (error) {
        if (!(error instanceof PackageAllocationLedgerRepositoryError)
            || error.code !== "CONCURRENT_WRITE"
            || attempt >= MAX_SERIALIZABLE_ATTEMPTS) {
          throw error;
        }
        attempt += 1;
      }
    }
  }

  private async persistOnce(
    command: z.output<typeof persistPackageAllocationPlanCommandSchema>,
  ): Promise<PersistPackageAllocationPlanResult> {
    return this.repository.withSerializableTransaction(async (transaction) => {
      const group = await transaction.lockGroup(
        command.groupKey,
        command.expectedGroupVersion === 0,
      );
      if (group === null) {
        throw new PackageAllocationPersistenceError(
          "STALE_GROUP_VERSION",
          "The requested package allocation group does not exist at the expected version",
          { groupKey: command.groupKey, expectedGroupVersion: command.expectedGroupVersion },
        );
      }

      const basePlan = command.expectedGroupVersion === 0
        ? null
        : await transaction.loadPlanByVersion(group.id, command.expectedGroupVersion);
      if (command.expectedGroupVersion > 0 && basePlan === null) {
        throw new PackageAllocationPersistenceError(
          "CURRENT_PLAN_MISSING",
          "The expected package allocation plan version is missing",
          { groupKey: group.groupKey, expectedGroupVersion: command.expectedGroupVersion },
        );
      }

      const previousPlan = previousPlanFromPersisted(command.groupKey, basePlan);
      const sourceFacts = await transaction.lockSourceFacts(
        command.sourceLines.map((source) => source.wmsShipmentItemId),
      );
      const registrations = sourceFacts.map(derivePackageAllocationSourceRegistration);
      validateSourceQuantities(command, registrations);

      const plannerResult = planPackageAllocationGroup({
        contractVersion: command.contractVersion,
        authorityMode: command.authorityMode,
        groupKey: command.groupKey,
        expectedGroupVersion: command.expectedGroupVersion,
        previousPlan,
        sourceLines: command.sourceLines,
        packages: command.packages,
        actions: command.actions,
      });
      for (const intent of plannerResult.effectIntentsToAppend) assertIntentPayloadHash(intent);

      if (plannerResult.outcome === "unchanged") {
        if (group.currentVersion !== command.expectedGroupVersion) {
          throw new PackageAllocationPersistenceError(
            "STALE_GROUP_VERSION",
            "The package allocation group is not at the expected version",
            {
              groupKey: group.groupKey,
              expectedGroupVersion: command.expectedGroupVersion,
              actualGroupVersion: group.currentVersion,
            },
          );
        }
        await transaction.ensureSourceRegistrations(group, registrations, false);
        await transaction.ensurePackageBindings(
          group,
          plannerResult.state.packageEvidence,
          false,
        );
        const currentPlan = group.currentVersion === 0
          ? null
          : await transaction.loadPlanByVersion(group.id, group.currentVersion);
        if (currentPlan === null || currentPlan.stateHash !== plannerResult.stateHash) {
          throw new PackageAllocationPersistenceError(
            "CURRENT_PLAN_MISSING",
            "An unchanged projection does not match the locked current plan",
            { groupKey: group.groupKey, currentGroupVersion: group.currentVersion },
          );
        }
        return Object.freeze({
          kind: "unchanged" as const,
          groupId: group.id,
          planId: currentPlan.id,
          persistedPlanVersion: currentPlan.planVersion,
          currentGroupVersion: group.currentVersion,
          plannerResult,
        });
      }

      const existingPlan = await transaction.loadPlanByInputHash(group.id, plannerResult.evidenceHash);
      if (existingPlan !== null) {
        await transaction.ensureSourceRegistrations(group, registrations, false);
        await transaction.ensurePackageBindings(group, plannerResult.state.packageEvidence, false);
        await assertExactReplay(
          transaction,
          existingPlan,
          plannerResult,
          command.writeContext,
        );
        return Object.freeze({
          kind: "already_persisted" as const,
          groupId: group.id,
          planId: existingPlan.id,
          persistedPlanVersion: existingPlan.planVersion,
          currentGroupVersion: group.currentVersion,
          plannerResult,
        });
      }

      if (group.currentVersion !== command.expectedGroupVersion) {
        throw new PackageAllocationPersistenceError(
          "STALE_GROUP_VERSION",
          "The package allocation group is not at the expected version",
          {
            groupKey: group.groupKey,
            expectedGroupVersion: command.expectedGroupVersion,
            actualGroupVersion: group.currentVersion,
          },
        );
      }

      const allowSourceCreate = group.currentVersion === 0;
      const sourcesByWmsItemId = await transaction.ensureSourceRegistrations(
        group,
        registrations,
        allowSourceCreate,
      );
      const bindingsByPackageKey = await transaction.ensurePackageBindings(
        group,
        plannerResult.state.packageEvidence,
        true,
      );

      const planId = await transaction.appendPlan({
        group,
        planVersion: plannerResult.proposedGroupVersion,
        inputHash: plannerResult.evidenceHash,
        stateHash: plannerResult.stateHash,
        outcome: plannerResult.outcome,
        plannerVersion: PACKAGE_ALLOCATION_PLANNER_VERSION,
        reason: command.writeContext.reason,
        createdBy: command.writeContext.createdBy,
        stateSnapshot: plannerResult.state,
        reviewSnapshot: Object.freeze({
          contractVersion: 1 as const,
          reviews: plannerResult.state.reviews,
        }),
        entries: plannerResult.ledgerEntriesToAppend,
        intents: plannerResult.effectIntentsToAppend,
        sourcesByWmsItemId,
        bindingsByPackageKey,
      });
      return Object.freeze({
        kind: "created" as const,
        groupId: group.id,
        planId,
        persistedPlanVersion: plannerResult.proposedGroupVersion,
        currentGroupVersion: plannerResult.proposedGroupVersion,
        plannerResult,
      });
    });
  }
}
