import { z } from "zod";

import type {
  ReconcileOrderDemandCommand,
  ReconcileOrderDemandResult,
} from "../../channels/reservation.service";
import {
  assessHistoricalIdentityRepairLine,
  extractHistoricalRepairSourceLine,
  historicalIdentityRepairApplySchema,
  historicalIdentityRepairOrderIdSchema,
  historicalIdentityRepairPreviewHash,
  historicalIdentityRepairRequestHash,
  HistoricalIdentityRepairError,
  isHistoricalIdentityRepairCandidate,
  type HistoricalIdentityRepairApplyInput,
  type HistoricalIdentityRepairCommandRecord,
  type HistoricalIdentityRepairPreparedResult,
  type HistoricalIdentityRepairPreview,
  type HistoricalRepairLineEvidence,
  type HistoricalRepairLinePreview,
  type HistoricalRepairSourceLineIdentity,
} from "../domain/historical-order-line-identity-repair";
import { OrderLineIdentityError, type ResolvedOrderLineIdentity } from "../domain/order-line-catalog-identity";
import {
  createHistoricalIdentityRepairRepository,
  type HistoricalIdentityRepairDatabase,
  type HistoricalIdentityRepairRepository,
} from "../infrastructure/historical-order-line-identity-repair.repository";

const operatorSchema = z.string().trim().min(1).max(120)
  .regex(/^[^\u0000-\u001f\u007f]*$/);

export interface HistoricalIdentityRepairClaimOwner {
  reconcileOrderDemand(command: ReconcileOrderDemandCommand): Promise<ReconcileOrderDemandResult>;
}

export interface HistoricalIdentityRepairActor {
  readonly operator: string;
  readonly userId?: string;
}

export interface HistoricalIdentityRepairExecutionResult {
  readonly contractVersion: 1;
  readonly commandId: number;
  readonly status: "succeeded";
  readonly idempotentReplay: boolean;
  readonly repair: HistoricalIdentityRepairPreparedResult;
  readonly claim: unknown;
}

interface SafeLinePlan {
  readonly evidence: HistoricalRepairLineEvidence;
  readonly preview: HistoricalRepairLinePreview;
  readonly source: HistoricalRepairSourceLineIdentity;
  readonly identity: ResolvedOrderLineIdentity;
}

interface InternalPreview {
  readonly publicPreview: HistoricalIdentityRepairPreview;
  readonly safePlans: readonly SafeLinePlan[];
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string") {
    return String((error as { code: string }).code).slice(0, 100);
  }
  return "CLAIM_RECONCILIATION_FAILED";
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateExistingCommand(
  command: HistoricalIdentityRepairCommandRecord,
  input: { omsOrderId: number; requestHash: string },
): void {
  if (command.omsOrderId !== input.omsOrderId || command.requestHash !== input.requestHash) {
    throw new HistoricalIdentityRepairError(
      "REPAIR_IDEMPOTENCY_KEY_REUSED",
      "Idempotency key was already used for a different historical repair command",
      409,
      { commandId: command.id },
    );
  }
}

async function buildPreview(
  repository: HistoricalIdentityRepairRepository,
  omsOrderId: number,
  generatedAt: Date,
  lock: boolean,
): Promise<InternalPreview> {
  const aggregate = await repository.loadOrderEvidence(omsOrderId, lock);
  if (!aggregate) {
    throw new HistoricalIdentityRepairError(
      "OMS_ORDER_NOT_FOUND",
      `OMS order ${omsOrderId} was not found`,
      404,
      { omsOrderId },
    );
  }

  const previews: HistoricalRepairLinePreview[] = [];
  const safePlans: SafeLinePlan[] = [];
  for (const evidence of aggregate.lines) {
    if (!isHistoricalIdentityRepairCandidate(evidence)) continue;

    let source: HistoricalRepairSourceLineIdentity | null = null;
    let sourceFailure: string | null = null;
    try {
      if (!evidence.sourceInbox) throw new Error("linked source webhook evidence is missing");
      source = extractHistoricalRepairSourceLine(
        evidence.sourceInbox,
        evidence.omsLine.externalLineItemId,
      );
    } catch (error) {
      sourceFailure = safeErrorMessage(error);
    }

    let identity: ResolvedOrderLineIdentity | null = null;
    let identityFailure: { code: string; message: string } | null = null;
    if (source) {
      try {
        identity = await repository.resolveIdentity({
          channelId: aggregate.order.channelId,
          externalVariantId: source.externalVariantId,
          externalProductId: source.externalProductId,
          sku: source.sku,
          previousVariantId: evidence.omsLine.productVariantId,
        });
      } catch (error) {
        identityFailure = error instanceof OrderLineIdentityError
          ? { code: error.code, message: error.message }
          : { code: "IDENTITY_RESOLUTION_FAILED", message: "Canonical identity resolution failed" };
      }
    }

    const preview = assessHistoricalIdentityRepairLine({
      order: aggregate.order,
      evidence,
      source,
      sourceFailure,
      identity,
      identityFailure,
    });
    previews.push(preview);
    if (preview.disposition === "safe" && source && identity) {
      safePlans.push(Object.freeze({ evidence, preview, source, identity }));
    }
  }

  const sortedPreviews = Object.freeze(
    previews.sort((left, right) => left.omsOrderLineId - right.omsOrderLineId),
  );
  const previewHash = historicalIdentityRepairPreviewHash({
    order: aggregate.order,
    lines: sortedPreviews,
  });
  return Object.freeze({
    publicPreview: Object.freeze({
      contractVersion: 1,
      generatedAt: generatedAt.toISOString(),
      omsOrderId: aggregate.order.id,
      channelId: aggregate.order.channelId,
      orderStatus: aggregate.order.status,
      linkedWmsOrderIds: aggregate.order.linkedWmsOrderIds,
      previewHash,
      safeCount: sortedPreviews.filter((line) => line.disposition === "safe").length,
      reviewCount: sortedPreviews.filter((line) => line.disposition === "review").length,
      lines: sortedPreviews,
    }),
    safePlans: Object.freeze(safePlans),
  });
}

export class HistoricalOrderLineIdentityRepairService {
  constructor(
    private readonly repository: HistoricalIdentityRepairRepository,
    private readonly claimOwner: HistoricalIdentityRepairClaimOwner,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async preview(rawOmsOrderId: unknown): Promise<HistoricalIdentityRepairPreview> {
    const parsed = historicalIdentityRepairOrderIdSchema.safeParse(rawOmsOrderId);
    if (!parsed.success) {
      throw new HistoricalIdentityRepairError(
        "REPAIR_INPUT_INVALID",
        "omsOrderId must be a positive integer",
        400,
      );
    }
    return (await buildPreview(this.repository, parsed.data, this.now(), false)).publicPreview;
  }

  async apply(
    rawOmsOrderId: unknown,
    rawInput: unknown,
    rawActor: HistoricalIdentityRepairActor,
  ): Promise<HistoricalIdentityRepairExecutionResult> {
    const orderId = historicalIdentityRepairOrderIdSchema.safeParse(rawOmsOrderId);
    const request = historicalIdentityRepairApplySchema.safeParse(rawInput);
    const operator = operatorSchema.safeParse(rawActor.operator);
    if (!orderId.success || !request.success || !operator.success) {
      throw new HistoricalIdentityRepairError(
        "REPAIR_INPUT_INVALID",
        "omsOrderId, expectedPreviewHash, idempotencyKey, reason, and operator must be valid",
        400,
      );
    }
    const input: HistoricalIdentityRepairApplyInput = request.data;
    const requestHash = historicalIdentityRepairRequestHash({
      omsOrderId: orderId.data,
      expectedPreviewHash: input.expectedPreviewHash,
      reason: input.reason,
    });
    let created = false;

    const command = await this.repository.transaction(async (txRepository) => {
      await txRepository.acquireOrderLock(orderId.data);
      const prior = await txRepository.findCommand(input.idempotencyKey, true);
      if (prior) {
        validateExistingCommand(prior, { omsOrderId: orderId.data, requestHash });
        return prior;
      }

      const preview = await buildPreview(txRepository, orderId.data, this.now(), true);
      if (preview.publicPreview.previewHash !== input.expectedPreviewHash) {
        throw new HistoricalIdentityRepairError(
          "REPAIR_PREVIEW_STALE",
          "Repair evidence changed after preview; generate and review a new preview",
          409,
          {
            expectedPreviewHash: input.expectedPreviewHash,
            currentPreviewHash: preview.publicPreview.previewHash,
          },
        );
      }
      if (preview.publicPreview.reviewCount > 0) {
        throw new HistoricalIdentityRepairError(
          "REPAIR_REVIEW_REQUIRED",
          "Repair preview contains lines that require manual review",
          409,
          { reviewCount: preview.publicPreview.reviewCount },
        );
      }
      if (preview.safePlans.length === 0) {
        throw new HistoricalIdentityRepairError(
          "REPAIR_NOT_REQUIRED",
          "No historical lines on this order require identity repair",
          409,
          { omsOrderId: orderId.data },
        );
      }
      const wmsOrderIds = new Set(preview.safePlans.map((plan) => plan.preview.wmsOrderId));
      if (wmsOrderIds.size !== 1 || wmsOrderIds.has(null)) {
        throw new HistoricalIdentityRepairError(
          "REPAIR_WMS_ORDER_SCOPE_INVALID",
          "All repaired lines must belong to exactly one WMS order",
          409,
        );
      }
      const wmsOrderId = [...wmsOrderIds][0] as number;
      const expectedChanges = Object.freeze(preview.safePlans.map((plan) => Object.freeze({
        omsOrderLineId: plan.evidence.omsLine.id,
        wmsOrderItemId: plan.preview.wmsOrderItemId!,
        previousOmsVariantId: plan.evidence.omsLine.productVariantId,
        productVariantId: plan.identity.id,
        previousWmsVariantId: plan.preview.currentWmsVariantId,
        previousWmsSku: plan.preview.currentWmsSku!,
        catalogSku: plan.identity.sku!.trim(),
      })));
      const prepared: HistoricalIdentityRepairPreparedResult = Object.freeze({
        contractVersion: 1,
        omsOrderId: orderId.data,
        wmsOrderId,
        previewHash: preview.publicPreview.previewHash,
        repairedLines: expectedChanges,
      });
      const inserted = await txRepository.insertCommand({
        omsOrderId: orderId.data,
        wmsOrderId,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        previewHash: preview.publicPreview.previewHash,
        operator: operator.data,
        reason: input.reason,
        targetOmsLineIds: expectedChanges.map((line) => line.omsOrderLineId),
        repairResult: prepared,
        now: this.now(),
      });
      if (!inserted) {
        const concurrent = await txRepository.findCommand(input.idempotencyKey, true);
        if (!concurrent) {
          throw new HistoricalIdentityRepairError(
            "REPAIR_COMMAND_INSERT_FAILED",
            "Repair command could not be persisted",
            500,
          );
        }
        validateExistingCommand(concurrent, { omsOrderId: orderId.data, requestHash });
        return concurrent;
      }

      const sourceEventId = `historical-line-identity-repair:${input.idempotencyKey}`;
      const actualChanges = [];
      for (const plan of preview.safePlans) {
        actualChanges.push(await txRepository.repairLine({
          orderId: orderId.data,
          channelId: preview.publicPreview.channelId,
          omsOrderLineId: plan.evidence.omsLine.id,
          wmsOrderItemId: plan.preview.wmsOrderItemId!,
          previousOmsVariantId: plan.evidence.omsLine.productVariantId,
          previousWmsVariantId: plan.preview.currentWmsVariantId,
          previousWmsSku: plan.preview.currentWmsSku!,
          identity: plan.identity,
          source: plan.source,
          sourceEventId,
          now: this.now(),
        }));
      }
      if (JSON.stringify(actualChanges) !== JSON.stringify(expectedChanges)) {
        throw new HistoricalIdentityRepairError(
          "REPAIR_RESULT_MISMATCH",
          "Persisted repair result differs from the locked repair plan",
          500,
        );
      }
      await txRepository.recordPreparedEvent({
        orderId: orderId.data,
        commandId: inserted.id,
        operator: operator.data,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
        prepared,
      });
      created = true;
      return inserted;
    });

    if (command.status === "succeeded") {
      return Object.freeze({
        contractVersion: 1,
        commandId: command.id,
        status: "succeeded",
        idempotentReplay: true,
        repair: command.repairResult,
        claim: command.claimResult,
      });
    }

    const sourceEventId = `historical-line-identity-repair:${command.idempotencyKey}`;
    let completed: HistoricalIdentityRepairCommandRecord;
    try {
      // Keep the order-scoped advisory lock while the canonical claim owner
      // runs. The claim owns its own serializable transaction, but this outer
      // lock prevents two retries of this repair command from racing it.
      completed = await this.repository.transaction(async (txRepository) => {
        await txRepository.acquireOrderLock(command.omsOrderId);
        const current = await txRepository.findCommand(input.idempotencyKey, true);
        if (!current) {
          throw new HistoricalIdentityRepairError(
            "REPAIR_COMMAND_MISSING",
            "Repair command disappeared before completion",
            500,
            { commandId: command.id },
          );
        }
        validateExistingCommand(current, { omsOrderId: orderId.data, requestHash });
        if (current.status === "succeeded") return current;
        const claimResult: ReconcileOrderDemandResult = await this.claimOwner.reconcileOrderDemand({
          orderId: current.wmsOrderId,
          sourceEventId,
          demandChanged: true,
          reason: `Historical order-line identity repair: ${current.reason}`,
          ...(rawActor.userId ? { userId: rawActor.userId } : {}),
        });
        const updated = await txRepository.markCommandSucceeded(current.id, claimResult, this.now());
        await txRepository.recordClaimEvent({
          orderId: current.omsOrderId,
          commandId: current.id,
          initiatedBy: current.operator,
          reconciledBy: operator.data,
          sourceEventId,
          claimResult,
        });
        return updated;
      });
    } catch (error) {
      try {
        await this.repository.markCommandFailed(
          command.id,
          errorCode(error),
          safeErrorMessage(error),
          this.now(),
        );
      } catch (recordError) {
        console.error(JSON.stringify({
          code: "REPAIR_FAILURE_RECORD_FAILED",
          commandId: command.id,
          error: safeErrorMessage(recordError),
        }));
      }
      throw new HistoricalIdentityRepairError(
        "REPAIR_CLAIM_RECONCILIATION_FAILED",
        "OMS/WMS identity repair committed, but canonical inventory claim reconciliation failed; retry this idempotency key",
        503,
        { commandId: command.id, identityRepairCommitted: true },
      );
    }

    return Object.freeze({
      contractVersion: 1,
      commandId: completed.id,
      status: "succeeded",
      idempotentReplay: !created,
      repair: completed.repairResult,
      claim: completed.claimResult,
    });
  }
}

export function createHistoricalOrderLineIdentityRepairService(
  database: HistoricalIdentityRepairDatabase,
  claimOwner: HistoricalIdentityRepairClaimOwner,
  now?: () => Date,
): HistoricalOrderLineIdentityRepairService {
  return new HistoricalOrderLineIdentityRepairService(
    createHistoricalIdentityRepairRepository(database),
    claimOwner,
    now,
  );
}
