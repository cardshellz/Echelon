import { createHash } from "node:crypto";
import type {
  ReturnDispositionInspectionResolution,
  ReturnDispositionTreatment,
} from "@shared/schema";
import {
  deriveReturnCaseActionPlan,
  type ReturnCaseActionContext,
  type ReturnCaseActionKind,
  type ReturnCaseDispositionSummary,
  type ReturnCaseInventoryTreatmentSummary,
} from "../domain/return-case-actions";

export interface ReturnCaseOperationAggregate {
  caseId: number;
  caseNumber: string;
  omsOrderId: number;
  wmsReturnId: number;
  wmsOrderId: number;
  items: Array<{
    returnCaseItemId: number;
    omsOrderLineId: number | null;
    wmsOrderItemId: number | null;
    productVariantId: number | null;
  }>;
  actionContext: ReturnCaseActionContext;
}

export interface RecordReturnReceiptInput {
  caseId: number;
  idempotencyKey: string;
  actor: string;
  notes: string | null;
  lines: Array<{
    returnCaseItemId: number;
    expectedCurrentReceivedQuantity: number;
    quantityReceivedNow: number;
  }>;
}

export interface StartReturnInspectionInput {
  caseId: number;
  idempotencyKey: string;
  actor: string;
  notes: string | null;
}

export type ReturnInspectionOutcome = "approved" | "rejected";

export interface CompleteReturnInspectionInput {
  caseId: number;
  inspectionId: number;
  idempotencyKey: string;
  actor: string;
  outcome: ReturnInspectionOutcome;
  notes: string | null;
}

export interface RecordReturnDispositionInput {
  caseId: number;
  inspectionId: number | null;
  idempotencyKey: string;
  actor: string;
  notes: string | null;
  lines: Array<{
    returnCaseItemId: number;
    quantity: number;
    treatment: ReturnDispositionTreatment;
    expectedCurrentReceivedQuantity: number;
    expectedCurrentDisposedQuantity: number;
  }>;
}

export interface ApplyReturnInventoryTreatmentInput {
  caseId: number;
  idempotencyKey: string;
  actor: string;
  notes: string | null;
  lines: Array<{
    dispositionItemId: number;
    expectedTreatment: ReturnDispositionTreatment;
    expectedQuantity: number;
    warehouseLocationId: number | null;
  }>;
}

export interface RecordReturnReceiptResult {
  commandType: "record_receipt";
  caseId: number;
  caseNumber: string;
  wmsReturnId: number;
  logisticsStatus: "partially_received" | "received";
  expectedUnits: number;
  receivedUnits: number;
  remainingUnits: number;
  replayed: boolean;
}

export interface StartReturnInspectionResult {
  commandType: "start_inspection";
  caseId: number;
  caseNumber: string;
  inspectionId: number;
  inspectionStatus: "in_progress";
  startedAt: string;
  replayed: boolean;
}

export interface CompleteReturnInspectionResult {
  commandType: "complete_inspection";
  caseId: number;
  caseNumber: string;
  inspectionId: number;
  inspectionStatus: ReturnInspectionOutcome;
  completedAt: string;
  replayed: boolean;
}

export interface RecordReturnDispositionResult {
  commandType: "record_disposition";
  caseId: number;
  caseNumber: string;
  dispositionId: number;
  inspectionId: number | null;
  inspectionResolution: ReturnDispositionInspectionResolution;
  lines: Array<{
    returnCaseItemId: number;
    quantity: number;
    treatment: ReturnDispositionTreatment;
  }>;
  dispositionSummary: ReturnCaseDispositionSummary;
  recordedAt: string;
  replayed: boolean;
}

export interface ApplyReturnInventoryTreatmentResult {
  commandType: "apply_inventory_treatment";
  caseId: number;
  caseNumber: string;
  inventoryTreatmentId: number;
  lines: Array<{
    dispositionItemId: number;
    returnCaseItemId: number;
    productVariantId: number | null;
    treatment: ReturnDispositionTreatment;
    quantity: number;
    warehouseLocationId: number | null;
    inventoryTransactionId: number | null;
    inventoryLotId: number | null;
  }>;
  inventoryTreatmentSummary: ReturnCaseInventoryTreatmentSummary;
  appliedAt: string;
  replayed: boolean;
}

export type ReturnCaseOperationResult =
  | RecordReturnReceiptResult
  | StartReturnInspectionResult
  | CompleteReturnInspectionResult
  | RecordReturnDispositionResult
  | ApplyReturnInventoryTreatmentResult;

export interface PersistReturnReceiptInput {
  aggregate: ReturnCaseOperationAggregate;
  idempotencyKey: string;
  requestHash: string;
  actor: string;
  notes: string | null;
  lines: Array<{
    returnCaseItemId: number;
    wmsReturnItemId: number;
    expectedCurrentReceivedQuantity: number;
    targetReceivedQuantity: number;
  }>;
  now: Date;
}

export interface PersistStartInspectionInput {
  aggregate: ReturnCaseOperationAggregate;
  idempotencyKey: string;
  requestHash: string;
  actor: string;
  notes: string | null;
  now: Date;
}

export interface PersistCompleteInspectionInput {
  aggregate: ReturnCaseOperationAggregate;
  inspectionId: number;
  idempotencyKey: string;
  requestHash: string;
  actor: string;
  outcome: ReturnInspectionOutcome;
  notes: string | null;
  now: Date;
}

export interface PersistReturnDispositionInput {
  aggregate: ReturnCaseOperationAggregate;
  idempotencyKey: string;
  requestHash: string;
  actor: string;
  notes: string | null;
  inspectionId: number | null;
  inspectionResolution: ReturnDispositionInspectionResolution;
  lines: Array<{
    returnCaseItemId: number;
    quantity: number;
    treatment: ReturnDispositionTreatment;
    expectedCurrentReceivedQuantity: number;
    expectedCurrentDisposedQuantity: number;
  }>;
  dispositionSummary: ReturnCaseDispositionSummary;
  now: Date;
}

export interface PersistReturnInventoryTreatmentInput {
  aggregate: ReturnCaseOperationAggregate;
  idempotencyKey: string;
  requestHash: string;
  actor: string;
  notes: string | null;
  lines: Array<{
    dispositionItemId: number;
    returnCaseItemId: number;
    productVariantId: number | null;
    treatment: ReturnDispositionTreatment;
    quantity: number;
    warehouseLocationId: number | null;
  }>;
  now: Date;
}

export interface ExistingReturnCaseCommand {
  commandType: ReturnCaseActionKind;
  requestHash: string;
  result: ReturnCaseOperationResult;
}

export interface ReturnCaseOperationTransaction {
  lockCommand(idempotencyKey: string): Promise<void>;
  findCommand(idempotencyKey: string): Promise<ExistingReturnCaseCommand | null>;
  loadForUpdate(caseId: number): Promise<ReturnCaseOperationAggregate | null>;
  persistReceipt(input: PersistReturnReceiptInput): Promise<RecordReturnReceiptResult>;
  persistStartInspection(input: PersistStartInspectionInput): Promise<StartReturnInspectionResult>;
  persistCompleteInspection(input: PersistCompleteInspectionInput): Promise<CompleteReturnInspectionResult>;
  persistDisposition(input: PersistReturnDispositionInput): Promise<RecordReturnDispositionResult>;
  persistInventoryTreatment(input: PersistReturnInventoryTreatmentInput): Promise<ApplyReturnInventoryTreatmentResult>;
}

export interface ReturnCaseOperationStore {
  transaction<T>(work: (tx: ReturnCaseOperationTransaction) => Promise<T>): Promise<T>;
}

export class ReturnCaseOperationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ReturnCaseOperationError";
  }
}

export interface ReturnInventoryChangeNotifier {
  notify(productVariantId: number): void;
}

export class ReturnCaseOperationService {
  constructor(
    private readonly store: ReturnCaseOperationStore,
    private readonly clock: () => Date = () => new Date(),
    private readonly inventoryNotifier: ReturnInventoryChangeNotifier | null = null,
  ) {}

  async recordReceipt(rawInput: RecordReturnReceiptInput): Promise<RecordReturnReceiptResult> {
    const input = normalizeReceiptInput(rawInput);
    const requestHash = hashCommand("record_receipt", input);

    return this.store.transaction(async (tx) => {
      await tx.lockCommand(input.idempotencyKey);
      const replay = await resolveReplay(tx, input.idempotencyKey, "record_receipt", requestHash);
      if (replay) return requireReceiptResult(replay);

      const aggregate = await loadAggregate(tx, input.caseId);
      requireActionAvailable(aggregate.actionContext, "record_receipt");
      const receipt = aggregate.actionContext.receipt;
      if (!receipt) {
        // The action resolver blocks this state. Keep the invariant explicit so
        // persistence can never proceed if a future resolver change regresses it.
        throw new ReturnCaseOperationError(
          "RETURN_WMS_RETURN_MISSING",
          "Record returned items received is not available because WMS receipt evidence is missing.",
          409,
          { caseId: input.caseId },
        );
      }
      const receiptLines = receipt.items;
      const receiptLineByCaseItemId = new Map(receiptLines.map((line) => [line.returnCaseItemId, line]));
      const lines = input.lines.map((line) => {
        const receiptLine = receiptLineByCaseItemId.get(line.returnCaseItemId);
        if (!receiptLine) {
          throw new ReturnCaseOperationError(
            "RETURN_CASE_RECEIPT_ITEM_NOT_FOUND",
            "A receipt item does not belong to this return case.",
            409,
            { caseId: input.caseId, returnCaseItemId: line.returnCaseItemId },
          );
        }
        if (line.expectedCurrentReceivedQuantity !== receiptLine.wmsReceivedQuantity) {
          throw new ReturnCaseOperationError(
            "RETURN_CASE_RECEIPT_STATE_STALE",
            "The received quantity changed after this return was reviewed. Refresh the return case and try again.",
            409,
            {
              caseId: input.caseId,
              returnCaseItemId: line.returnCaseItemId,
              expectedCurrentReceivedQuantity: line.expectedCurrentReceivedQuantity,
              actualCurrentReceivedQuantity: receiptLine.wmsReceivedQuantity,
            },
          );
        }
        const targetReceivedQuantity = line.expectedCurrentReceivedQuantity + line.quantityReceivedNow;
        if (!Number.isSafeInteger(targetReceivedQuantity)
          || targetReceivedQuantity > receiptLine.wmsExpectedQuantity) {
          throw new ReturnCaseOperationError(
            "RETURN_CASE_RECEIPT_QUANTITY_EXCEEDED",
            "The receipt quantity exceeds the quantity still expected for an item.",
            409,
            {
              caseId: input.caseId,
              returnCaseItemId: line.returnCaseItemId,
              requestedNow: line.quantityReceivedNow,
              received: receiptLine.wmsReceivedQuantity,
              expected: receiptLine.wmsExpectedQuantity,
            },
          );
        }
        return {
          returnCaseItemId: line.returnCaseItemId,
          wmsReturnItemId: receiptLine.wmsReturnItemId,
          expectedCurrentReceivedQuantity: line.expectedCurrentReceivedQuantity,
          targetReceivedQuantity,
        };
      });

      const now = readClock(this.clock);
      return tx.persistReceipt({
        aggregate,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        actor: input.actor,
        notes: input.notes,
        lines,
        now,
      });
    });
  }

  async startInspection(rawInput: StartReturnInspectionInput): Promise<StartReturnInspectionResult> {
    const input = normalizeInspectionInput(rawInput);
    const requestHash = hashCommand("start_inspection", input);

    return this.store.transaction(async (tx) => {
      await tx.lockCommand(input.idempotencyKey);
      const replay = await resolveReplay(tx, input.idempotencyKey, "start_inspection", requestHash);
      if (replay) return requireInspectionResult(replay);

      const aggregate = await loadAggregate(tx, input.caseId);
      requireActionAvailable(aggregate.actionContext, "start_inspection");
      const now = readClock(this.clock);
      return tx.persistStartInspection({
        aggregate,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        actor: input.actor,
        notes: input.notes,
        now,
      });
    });
  }

  async completeInspection(rawInput: CompleteReturnInspectionInput): Promise<CompleteReturnInspectionResult> {
    const input = normalizeCompleteInspectionInput(rawInput);
    const requestHash = hashCommand("complete_inspection", input);

    return this.store.transaction(async (tx) => {
      await tx.lockCommand(input.idempotencyKey);
      const replay = await resolveReplay(tx, input.idempotencyKey, "complete_inspection", requestHash);
      if (replay) return requireCompleteInspectionResult(replay);

      const aggregate = await loadAggregate(tx, input.caseId);
      requireActionAvailable(aggregate.actionContext, "complete_inspection");
      const inspection = aggregate.actionContext.inspection;
      if (!inspection || inspection.inspectionId !== input.inspectionId || inspection.status !== "in_progress") {
        throw new ReturnCaseOperationError(
          "RETURN_CASE_INSPECTION_STATE_STALE",
          "The inspection changed after this return was reviewed. Refresh the return case and try again.",
          409,
          {
            caseId: input.caseId,
            expectedInspectionId: input.inspectionId,
            actualInspectionId: inspection?.inspectionId ?? null,
            actualInspectionStatus: inspection?.status ?? null,
          },
        );
      }
      const now = readClock(this.clock);
      return tx.persistCompleteInspection({
        aggregate,
        inspectionId: input.inspectionId,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        actor: input.actor,
        outcome: input.outcome,
        notes: input.notes,
        now,
      });
    });
  }

  async recordDisposition(rawInput: RecordReturnDispositionInput): Promise<RecordReturnDispositionResult> {
    const input = normalizeDispositionInput(rawInput);
    const requestHash = hashCommand("record_disposition", input);

    return this.store.transaction(async (tx) => {
      await tx.lockCommand(input.idempotencyKey);
      const replay = await resolveReplay(tx, input.idempotencyKey, "record_disposition", requestHash);
      if (replay) return requireDispositionResult(replay);

      const aggregate = await loadAggregate(tx, input.caseId);
      requireActionAvailable(aggregate.actionContext, "record_disposition");
      const inspectionEvidence = resolveDispositionInspectionEvidence(aggregate.actionContext, input.caseId);
      if (input.inspectionId !== inspectionEvidence.inspectionId) {
        throw new ReturnCaseOperationError(
          "RETURN_CASE_INSPECTION_STATE_STALE",
          "The inspection evidence changed after this return was reviewed. Refresh the return case and try again.",
          409,
          {
            caseId: input.caseId,
            expectedInspectionId: input.inspectionId,
            actualInspectionId: inspectionEvidence.inspectionId,
          },
        );
      }
      const dispositionSummary = buildDispositionSummary(aggregate.actionContext, input.lines, input.caseId);
      const now = readClock(this.clock);
      const receiptReceivedAt = aggregate.actionContext.receipt?.receivedAt;
      if (!(receiptReceivedAt instanceof Date) || Number.isNaN(receiptReceivedAt.getTime())) {
        throw new ReturnCaseOperationError(
          "RETURN_CASE_DATA_INVALID",
          "Disposition recording requires valid persisted return receipt evidence.",
          500,
          { caseId: input.caseId },
        );
      }
      if (now.getTime() < receiptReceivedAt.getTime()) {
        throw new ReturnCaseOperationError(
          "RETURN_CASE_DISPOSITION_TIME_INVALID",
          "Disposition evidence cannot predate the return receipt it depends on.",
          500,
          {
            caseId: input.caseId,
            receiptReceivedAt: receiptReceivedAt.toISOString(),
            dispositionRecordedAt: now.toISOString(),
          },
        );
      }
      if (inspectionEvidence.completedAt !== null
        && now.getTime() < inspectionEvidence.completedAt.getTime()) {
        throw new ReturnCaseOperationError(
          "RETURN_CASE_DISPOSITION_TIME_INVALID",
          "Disposition evidence cannot predate the terminal inspection it depends on.",
          500,
          {
            caseId: input.caseId,
            inspectionId: inspectionEvidence.inspectionId,
            inspectionCompletedAt: inspectionEvidence.completedAt.toISOString(),
            dispositionRecordedAt: now.toISOString(),
          },
        );
      }
      return tx.persistDisposition({
        aggregate,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        actor: input.actor,
        notes: input.notes,
        inspectionId: inspectionEvidence.inspectionId,
        inspectionResolution: inspectionEvidence.inspectionResolution,
        lines: input.lines,
        dispositionSummary,
        now,
      });
    });
  }

  async applyInventoryTreatment(
    rawInput: ApplyReturnInventoryTreatmentInput,
  ): Promise<ApplyReturnInventoryTreatmentResult> {
    const input = normalizeInventoryTreatmentInput(rawInput);
    const requestHash = hashCommand("apply_inventory_treatment", input);
    const result = await this.store.transaction(async (tx) => {
      await tx.lockCommand(input.idempotencyKey);
      const replay = await resolveReplay(tx, input.idempotencyKey, "apply_inventory_treatment", requestHash);
      if (replay) return requireInventoryTreatmentResult(replay);

      const aggregate = await loadAggregate(tx, input.caseId);
      requireActionAvailable(aggregate.actionContext, "apply_inventory_treatment");
      const plan = deriveReturnCaseActionPlan(aggregate.actionContext);
      const sourceById = new Map(
        plan.inventoryTreatmentSummary.items.map((item) => [item.dispositionItemId, item] as const),
      );
      const caseItemById = new Map(aggregate.items.map((item) => [item.returnCaseItemId, item] as const));
      const lines = input.lines.map((line) => {
        const source = sourceById.get(line.dispositionItemId);
        if (!source || source.applied) {
          throw new ReturnCaseOperationError(
            "RETURN_INVENTORY_TREATMENT_STATE_STALE",
            "The recorded disposition changed after this return was reviewed. Refresh and try again.",
            409,
            { caseId: input.caseId, dispositionItemId: line.dispositionItemId },
          );
        }
        if (source.treatment !== line.expectedTreatment || source.quantity !== line.expectedQuantity) {
          throw new ReturnCaseOperationError(
            "RETURN_INVENTORY_TREATMENT_STATE_STALE",
            "The recorded disposition changed after this return was reviewed. Refresh and try again.",
            409,
            { caseId: input.caseId, dispositionItemId: line.dispositionItemId },
          );
        }
        if ((source.treatment === "restock_sellable") !== (line.warehouseLocationId !== null)) {
          throw new ReturnCaseOperationError(
            "RETURN_CASE_OPERATION_INPUT_INVALID",
            source.treatment === "restock_sellable"
              ? "A pickable warehouse location is required for sellable restock."
              : "Held non-sellable inventory must not specify a sellable location.",
            400,
            { dispositionItemId: line.dispositionItemId },
          );
        }
        const caseItem = caseItemById.get(source.returnCaseItemId);
        if (!caseItem || (source.treatment === "restock_sellable" && caseItem.productVariantId === null)) {
          throw new ReturnCaseOperationError(
            "RETURN_INVENTORY_TREATMENT_VARIANT_MISSING",
            "Sellable restock requires an exact catalog variant for the returned item.",
            409,
            { caseId: input.caseId, returnCaseItemId: source.returnCaseItemId },
          );
        }
        return {
          dispositionItemId: source.dispositionItemId,
          returnCaseItemId: source.returnCaseItemId,
          // Product identity on this result represents a sellable inventory effect.
          // Held evidence remains linked through returnCaseItemId and never enters ATP.
          productVariantId: source.treatment === "restock_sellable" ? caseItem.productVariantId : null,
          treatment: source.treatment,
          quantity: source.quantity,
          warehouseLocationId: line.warehouseLocationId,
        };
      });
      return tx.persistInventoryTreatment({
        aggregate, idempotencyKey: input.idempotencyKey, requestHash,
        actor: input.actor, notes: input.notes, lines, now: readClock(this.clock),
      });
    });
    if (!result.replayed && this.inventoryNotifier) {
      for (const variantId of new Set(result.lines.flatMap((line) =>
        line.inventoryTransactionId !== null && line.productVariantId !== null ? [line.productVariantId] : []))) {
        this.inventoryNotifier.notify(variantId);
      }
    }
    return result;
  }
}

async function resolveReplay(
  tx: ReturnCaseOperationTransaction,
  idempotencyKey: string,
  commandType: ReturnCaseActionKind,
  requestHash: string,
): Promise<ReturnCaseOperationResult | null> {
  const existing = await tx.findCommand(idempotencyKey);
  if (!existing) return null;
  if (existing.commandType !== commandType || existing.requestHash !== requestHash) {
    throw new ReturnCaseOperationError(
      "RETURN_CASE_IDEMPOTENCY_CONFLICT",
      "This idempotency key was already used for a different return operation.",
      409,
      { idempotencyKey },
    );
  }
  return { ...existing.result, replayed: true };
}

async function loadAggregate(
  tx: ReturnCaseOperationTransaction,
  caseId: number,
): Promise<ReturnCaseOperationAggregate> {
  const aggregate = await tx.loadForUpdate(caseId);
  if (!aggregate) {
    throw new ReturnCaseOperationError(
      "RETURN_CASE_NOT_FOUND",
      "Return case was not found.",
      404,
      { caseId },
    );
  }
  return aggregate;
}

function requireActionAvailable(context: ReturnCaseActionContext, kind: ReturnCaseActionKind): void {
  const action = deriveReturnCaseActionPlan(context).actions.find((candidate) => candidate.kind === kind);
  if (!action || action.state !== "available") {
    throw new ReturnCaseOperationError(
      action?.reasonCode ?? "RETURN_CASE_ACTION_NOT_AVAILABLE",
      `${action?.label ?? "Return case action"} is not available for the current case state.`,
      409,
      { action: kind, state: action?.state ?? "missing" },
    );
  }
}

function normalizeReceiptInput(input: RecordReturnReceiptInput): RecordReturnReceiptInput {
  const common = normalizeCommon(input);
  if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > 200) {
    throw invalid("lines", input.lines);
  }
  const seen = new Set<number>();
  const lines = input.lines.map((line) => {
    const returnCaseItemId = requirePositiveSafeInteger(line?.returnCaseItemId, "returnCaseItemId");
    const expectedCurrentReceivedQuantity = requireNonNegativeSafeInteger(
      line?.expectedCurrentReceivedQuantity,
      "expectedCurrentReceivedQuantity",
    );
    const quantityReceivedNow = requirePositiveSafeInteger(line?.quantityReceivedNow, "quantityReceivedNow");
    if (seen.has(returnCaseItemId)) {
      throw new ReturnCaseOperationError(
        "RETURN_CASE_OPERATION_INPUT_INVALID",
        "A return case item may only appear once in a receipt command.",
        400,
        { returnCaseItemId },
      );
    }
    seen.add(returnCaseItemId);
    return { returnCaseItemId, expectedCurrentReceivedQuantity, quantityReceivedNow };
  }).sort((left, right) => left.returnCaseItemId - right.returnCaseItemId);
  return { ...common, lines };
}

function normalizeInspectionInput(input: StartReturnInspectionInput): StartReturnInspectionInput {
  return normalizeCommon(input);
}

function normalizeCompleteInspectionInput(input: CompleteReturnInspectionInput): CompleteReturnInspectionInput {
  return {
    ...normalizeCommon(input),
    inspectionId: requirePositiveSafeInteger(input.inspectionId, "inspectionId"),
    outcome: requireInspectionOutcome(input.outcome),
  };
}

function normalizeDispositionInput(input: RecordReturnDispositionInput): RecordReturnDispositionInput {
  const common = normalizeCommon(input);
  if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > 200) {
    throw invalid("lines", input.lines);
  }
  const seen = new Set<number>();
  const lines = input.lines.map((line) => {
    const returnCaseItemId = requirePositiveSafeInteger(line?.returnCaseItemId, "returnCaseItemId");
    if (seen.has(returnCaseItemId)) {
      throw new ReturnCaseOperationError(
        "RETURN_CASE_OPERATION_INPUT_INVALID",
        "A return case item may only appear once in a disposition command.",
        400,
        { returnCaseItemId },
      );
    }
    seen.add(returnCaseItemId);
    return {
      returnCaseItemId,
      quantity: requirePositiveSafeInteger(line?.quantity, "quantity"),
      treatment: requireDispositionTreatment(line?.treatment),
      expectedCurrentReceivedQuantity: requireNonNegativeSafeInteger(
        line?.expectedCurrentReceivedQuantity,
        "expectedCurrentReceivedQuantity",
      ),
      expectedCurrentDisposedQuantity: requireNonNegativeSafeInteger(
        line?.expectedCurrentDisposedQuantity,
        "expectedCurrentDisposedQuantity",
      ),
    };
  }).sort((left, right) => left.returnCaseItemId - right.returnCaseItemId);
  return { ...common, inspectionId: requireNullablePositiveSafeInteger(input.inspectionId, "inspectionId"), lines };
}

function normalizeInventoryTreatmentInput(
  input: ApplyReturnInventoryTreatmentInput,
): ApplyReturnInventoryTreatmentInput {
  const common = normalizeCommon(input);
  if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > 200) {
    throw invalid("lines", input.lines);
  }
  const seen = new Set<number>();
  const lines = input.lines.map((line) => {
    const dispositionItemId = requirePositiveSafeInteger(line?.dispositionItemId, "dispositionItemId");
    if (seen.has(dispositionItemId)) {
      throw new ReturnCaseOperationError(
        "RETURN_CASE_OPERATION_INPUT_INVALID",
        "A disposition item may only appear once in an inventory-treatment command.",
        400,
        { dispositionItemId },
      );
    }
    seen.add(dispositionItemId);
    return {
      dispositionItemId,
      expectedTreatment: requireDispositionTreatment(line?.expectedTreatment),
      expectedQuantity: requirePositiveSafeInteger(line?.expectedQuantity, "expectedQuantity"),
      warehouseLocationId: requireNullablePositiveSafeInteger(line?.warehouseLocationId, "warehouseLocationId"),
    };
  }).sort((left, right) => left.dispositionItemId - right.dispositionItemId);
  return { ...common, lines };
}

function normalizeCommon<T extends {
  caseId: number;
  idempotencyKey: string;
  actor: string;
  notes: string | null;
}>(input: T): Pick<T, "caseId" | "idempotencyKey" | "actor" | "notes"> {
  return {
    caseId: requirePositiveSafeInteger(input.caseId, "caseId"),
    idempotencyKey: normalizeRequiredText(input.idempotencyKey, "idempotencyKey", 160),
    actor: normalizeRequiredText(input.actor, "actor", 255),
    notes: input.notes === null ? null : normalizeOptionalText(input.notes, "notes", 2_000),
  };
}

function hashCommand(
  commandType: ReturnCaseActionKind,
  input:
    | RecordReturnReceiptInput
    | StartReturnInspectionInput
    | CompleteReturnInspectionInput
    | RecordReturnDispositionInput
    | ApplyReturnInventoryTreatmentInput,
): string {
  const request = "lines" in input && "inspectionId" in input
    ? { commandType, caseId: input.caseId, inspectionId: input.inspectionId, notes: input.notes, lines: input.lines }
    : "lines" in input
      ? { commandType, caseId: input.caseId, notes: input.notes, lines: input.lines }
      : "outcome" in input
      ? {
          commandType,
          caseId: input.caseId,
          inspectionId: input.inspectionId,
          outcome: input.outcome,
          notes: input.notes,
        }
      : { commandType, caseId: input.caseId, notes: input.notes };
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

function readClock(clock: () => Date): Date {
  const now = clock();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new ReturnCaseOperationError("RETURN_CASE_CLOCK_INVALID", "Return case clock returned an invalid date.", 500);
  }
  return now;
}

function requireReceiptResult(result: ReturnCaseOperationResult): RecordReturnReceiptResult {
  if (result.commandType !== "record_receipt") {
    throw new ReturnCaseOperationError("RETURN_CASE_COMMAND_DATA_INVALID", "Stored return command data is inconsistent.", 500);
  }
  return result;
}

function requireInspectionResult(result: ReturnCaseOperationResult): StartReturnInspectionResult {
  if (result.commandType !== "start_inspection") {
    throw new ReturnCaseOperationError("RETURN_CASE_COMMAND_DATA_INVALID", "Stored return command data is inconsistent.", 500);
  }
  return result;
}

function requireCompleteInspectionResult(result: ReturnCaseOperationResult): CompleteReturnInspectionResult {
  if (result.commandType !== "complete_inspection") {
    throw new ReturnCaseOperationError("RETURN_CASE_COMMAND_DATA_INVALID", "Stored return command data is inconsistent.", 500);
  }
  return result;
}

function requireDispositionResult(result: ReturnCaseOperationResult): RecordReturnDispositionResult {
  if (result.commandType !== "record_disposition") {
    throw new ReturnCaseOperationError(
      "RETURN_CASE_COMMAND_DATA_INVALID",
      "Stored return command data is inconsistent.",
      500,
    );
  }
  return result;
}

function requireInventoryTreatmentResult(
  result: ReturnCaseOperationResult,
): ApplyReturnInventoryTreatmentResult {
  if (result.commandType !== "apply_inventory_treatment") {
    throw new ReturnCaseOperationError(
      "RETURN_CASE_COMMAND_DATA_INVALID",
      "Stored return command data is inconsistent.",
      500,
    );
  }
  return result;
}

function resolveDispositionInspectionEvidence(
  context: ReturnCaseActionContext,
  caseId: number,
): {
  inspectionId: number | null;
  inspectionResolution: ReturnDispositionInspectionResolution;
  completedAt: Date | null;
} {
  if (context.lifecycle.inspectionStatus === "not_required") {
    if (context.inspection !== null) {
      throw inspectionStateStale(caseId, context);
    }
    return { inspectionId: null, inspectionResolution: "not_required", completedAt: null };
  }

  const inspection = context.inspection;
  if (!inspection
    || (inspection.status !== "approved" && inspection.status !== "rejected")
    || context.lifecycle.inspectionStatus !== inspection.status
    || !Number.isSafeInteger(inspection.inspectionId)
    || inspection.inspectionId <= 0
    || !(inspection.startedAt instanceof Date)
    || Number.isNaN(inspection.startedAt.getTime())
    || !(inspection.completedAt instanceof Date)
    || Number.isNaN(inspection.completedAt.getTime())
    || inspection.completedAt.getTime() < inspection.startedAt.getTime()
    || typeof inspection.startedBy !== "string"
    || inspection.startedBy.trim() === ""
    || typeof inspection.completedBy !== "string"
    || inspection.completedBy.trim() === "") {
    throw inspectionStateStale(caseId, context);
  }

  return {
    inspectionId: inspection.inspectionId,
    inspectionResolution: inspection.status,
    completedAt: inspection.completedAt,
  };
}

function inspectionStateStale(
  caseId: number,
  context: ReturnCaseActionContext,
): ReturnCaseOperationError {
  return new ReturnCaseOperationError(
    "RETURN_CASE_INSPECTION_STATE_STALE",
    "The inspection evidence changed after this return was reviewed. Refresh the return case and try again.",
    409,
    {
      caseId,
      lifecycleInspectionStatus: context.lifecycle.inspectionStatus,
      inspectionId: context.inspection?.inspectionId ?? null,
      inspectionStatus: context.inspection?.status ?? null,
    },
  );
}

function buildDispositionSummary(
  context: ReturnCaseActionContext,
  lines: RecordReturnDispositionInput["lines"],
  caseId: number,
): ReturnCaseDispositionSummary {
  const current = deriveReturnCaseActionPlan(context).dispositionSummary;
  const itemById = new Map<number, ReturnCaseDispositionSummary["items"][number]>(
    current.items.map((item): [number, ReturnCaseDispositionSummary["items"][number]] =>
      [item.returnCaseItemId, { ...item }]),
  );

  for (const line of lines) {
    const item = itemById.get(line.returnCaseItemId);
    if (!item) {
      throw new ReturnCaseOperationError(
        "RETURN_CASE_DISPOSITION_ITEM_NOT_FOUND",
        "A disposition item does not belong to this return case.",
        409,
        { caseId, returnCaseItemId: line.returnCaseItemId },
      );
    }
    if (line.expectedCurrentReceivedQuantity !== item.receivedQuantity
      || line.expectedCurrentDisposedQuantity !== item.recordedQuantity) {
      throw new ReturnCaseOperationError(
        "RETURN_CASE_DISPOSITION_STATE_STALE",
        "The received or disposition quantity changed after this return was reviewed. Refresh the return case and try again.",
        409,
        {
          caseId,
          returnCaseItemId: line.returnCaseItemId,
          expectedCurrentReceivedQuantity: line.expectedCurrentReceivedQuantity,
          actualCurrentReceivedQuantity: item.receivedQuantity,
          expectedCurrentDisposedQuantity: line.expectedCurrentDisposedQuantity,
          actualCurrentDisposedQuantity: item.recordedQuantity,
        },
      );
    }
    if (line.quantity > item.remainingQuantity) {
      throw new ReturnCaseOperationError(
        "RETURN_CASE_DISPOSITION_QUANTITY_EXCEEDED",
        "The disposition quantity exceeds the received quantity still awaiting treatment.",
        409,
        {
          caseId,
          returnCaseItemId: line.returnCaseItemId,
          requestedQuantity: line.quantity,
          receivedQuantity: item.receivedQuantity,
          recordedQuantity: item.recordedQuantity,
          remainingQuantity: item.remainingQuantity,
        },
      );
    }

    if (line.treatment === "restock_sellable") {
      item.restockSellableQuantity = checkedEvidenceAdd(
        item.restockSellableQuantity,
        line.quantity,
        "restock sellable quantity",
      );
    } else {
      item.holdNonSellableQuantity = checkedEvidenceAdd(
        item.holdNonSellableQuantity,
        line.quantity,
        "hold non-sellable quantity",
      );
    }
    item.recordedQuantity = checkedEvidenceAdd(
      item.recordedQuantity,
      line.quantity,
      "recorded disposition quantity",
    );
    item.remainingQuantity = item.receivedQuantity - item.recordedQuantity;
  }

  const items = Array.from(itemById.values())
    .sort((left, right) => left.returnCaseItemId - right.returnCaseItemId);
  const recordedUnits = checkedEvidenceSum(
    items.map((item) => item.recordedQuantity),
    "recorded disposition units",
  );
  const receivedUnits = checkedEvidenceSum(
    items.map((item) => item.receivedQuantity),
    "received disposition units",
  );
  const remainingUnits = receivedUnits - recordedUnits;
  return {
    receivedUnits,
    recordedUnits,
    remainingUnits,
    fullyRecorded: receivedUnits > 0 && remainingUnits === 0,
    partiallyRecorded: recordedUnits > 0 && remainingUnits > 0,
    items,
  };
}

function requireDispositionTreatment(value: unknown): ReturnDispositionTreatment {
  if (value === "restock_sellable" || value === "hold_non_sellable") return value;
  throw invalid("treatment", value);
}

function checkedEvidenceAdd(left: number, right: number, field: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new ReturnCaseOperationError(
      "RETURN_CASE_DATA_INVALID",
      field + " exceeds the supported range.",
      500,
    );
  }
  return result;
}

function checkedEvidenceSum(values: readonly number[], field: string): number {
  return values.reduce(
    (total, value) => checkedEvidenceAdd(total, value, field),
    0,
  );
}

function requireInspectionOutcome(value: unknown): ReturnInspectionOutcome {
  if (value === "approved" || value === "rejected") return value;
  throw invalid("outcome", value);
}

function requirePositiveSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw invalid(field, value);
  return Number(value);
}

function requireNonNegativeSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw invalid(field, value);
  return Number(value);
}
function requireNullablePositiveSafeInteger(value: unknown, field: string): number | null {
  if (value === null) return null;
  return requirePositiveSafeInteger(value, field);
}


function normalizeRequiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw invalid(field, value);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw invalid(field, value);
  return normalized;
}

function normalizeOptionalText(value: unknown, field: string, maxLength: number): string | null {
  if (typeof value !== "string") throw invalid(field, value);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw invalid(field, value);
  return normalized || null;
}

function invalid(field: string, value: unknown): ReturnCaseOperationError {
  return new ReturnCaseOperationError(
    "RETURN_CASE_OPERATION_INPUT_INVALID",
    `${field} is invalid.`,
    400,
    { field, value },
  );
}
