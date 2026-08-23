import { z } from "zod";

const MAX_RECEIPT_LINES = 200;
const MAX_DISPOSITION_LINES = 200;
const MAX_INVENTORY_TREATMENT_LINES = 200;
const MAX_BIN_ASSIGNMENT_VARIANT_IDS = 200;
const MAX_NOTES_LENGTH = 2_000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 160;

const positiveSafeIntegerSchema = z.number().int().positive().safe();
const nonNegativeSafeIntegerSchema = z.number().int().nonnegative().safe();
const requiredTextSchema = z.string().trim().min(1);
const nullableTextSchema = z.string().nullable();
const nullableRequiredTextSchema = z.string().trim().min(1).nullable();
const dateTimeSchema = z.string().datetime({ offset: true });

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(jsonValueSchema),
]));

export const returnCaseActionKindSchema = z.enum([
  "record_receipt",
  "start_inspection",
  "complete_inspection",
  "record_disposition",
  "apply_inventory_treatment",
]);
export const returnCaseActionStateSchema = z.enum([
  "available",
  "blocked",
  "completed",
  "not_applicable",
]);
export const returnCaseReceiptStatusSchema = z.enum([
  "expected",
  "partially_received",
  "received",
]);
export const returnCaseDispositionTreatmentSchema = z.enum([
  "restock_sellable",
  "hold_non_sellable",
]);

export const returnCaseActionSchema = z.object({
  kind: returnCaseActionKindSchema,
  label: requiredTextSchema,
  description: requiredTextSchema,
  state: returnCaseActionStateSchema,
  reasonCode: z.string().trim().min(1).max(160).nullable(),
}).strict();

export const returnCaseReceiptSummarySchema = z.object({
  expectedUnits: nonNegativeSafeIntegerSchema,
  receivedUnits: nonNegativeSafeIntegerSchema,
  remainingUnits: nonNegativeSafeIntegerSchema,
  fullyReceived: z.boolean(),
  partiallyReceived: z.boolean(),
}).strict().superRefine((summary, context) => {
  if (!Number.isSafeInteger(summary.receivedUnits + summary.remainingUnits)
    || summary.expectedUnits !== summary.receivedUnits + summary.remainingUnits) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Receipt totals are inconsistent.",
      path: ["expectedUnits"],
    });
  }
  if (summary.fullyReceived !== (summary.expectedUnits > 0 && summary.remainingUnits === 0)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "fullyReceived is inconsistent with the receipt totals.",
      path: ["fullyReceived"],
    });
  }
  if (summary.partiallyReceived !== (summary.receivedUnits > 0 && summary.remainingUnits > 0)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "partiallyReceived is inconsistent with the receipt totals.",
      path: ["partiallyReceived"],
    });
  }
});

export const returnCaseInspectionSummarySchema = z.object({
  inspectionId: positiveSafeIntegerSchema,
  status: z.enum(["in_progress", "approved", "rejected", "cancelled"]),
  startedAt: dateTimeSchema,
  startedBy: requiredTextSchema,
  completedAt: dateTimeSchema.nullable(),
  completedBy: nullableRequiredTextSchema,
}).strict().superRefine((inspection, context) => {
  const completionIsEmpty = inspection.completedAt === null && inspection.completedBy === null;
  const completionIsComplete = inspection.completedAt !== null && inspection.completedBy !== null;
  const evidenceIsConsistent = inspection.status === "in_progress"
    ? completionIsEmpty
    : completionIsComplete;
  if (!evidenceIsConsistent) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Inspection completion evidence is inconsistent with its status.",
      path: ["status"],
    });
  }
  if (inspection.completedAt !== null
    && Date.parse(inspection.completedAt) < Date.parse(inspection.startedAt)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Inspection completion cannot precede its start.",
      path: ["completedAt"],
    });
  }
});

export const returnCaseDispositionSummaryItemSchema = z.object({
  returnCaseItemId: positiveSafeIntegerSchema,
  receivedQuantity: nonNegativeSafeIntegerSchema,
  restockSellableQuantity: nonNegativeSafeIntegerSchema,
  holdNonSellableQuantity: nonNegativeSafeIntegerSchema,
  recordedQuantity: nonNegativeSafeIntegerSchema,
  remainingQuantity: nonNegativeSafeIntegerSchema,
}).strict().superRefine((item, context) => {
  if (!Number.isSafeInteger(item.restockSellableQuantity + item.holdNonSellableQuantity)
    || item.recordedQuantity !== item.restockSellableQuantity + item.holdNonSellableQuantity) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Recorded disposition quantity is inconsistent with its treatments.",
      path: ["recordedQuantity"],
    });
  }
  if (!Number.isSafeInteger(item.recordedQuantity + item.remainingQuantity)
    || item.receivedQuantity !== item.recordedQuantity + item.remainingQuantity) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Disposition quantities are inconsistent with the received quantity.",
      path: ["receivedQuantity"],
    });
  }
});

export const returnCaseDispositionSummarySchema = z.object({
  receivedUnits: nonNegativeSafeIntegerSchema,
  recordedUnits: nonNegativeSafeIntegerSchema,
  remainingUnits: nonNegativeSafeIntegerSchema,
  fullyRecorded: z.boolean(),
  partiallyRecorded: z.boolean(),
  items: z.array(returnCaseDispositionSummaryItemSchema),
}).strict().superRefine((summary, context) => {
  const seenIds = new Set<number>();
  const itemTotals = summary.items.reduce(
    (totals, item, index) => {
      if (seenIds.has(item.returnCaseItemId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "A disposition summary item may only appear once.",
          path: ["items", index, "returnCaseItemId"],
        });
      }
      seenIds.add(item.returnCaseItemId);
      return {
        received: totals.received + item.receivedQuantity,
        recorded: totals.recorded + item.recordedQuantity,
        remaining: totals.remaining + item.remainingQuantity,
      };
    },
    { received: 0, recorded: 0, remaining: 0 },
  );
  if (!Object.values(itemTotals).every(Number.isSafeInteger)
    || itemTotals.received !== summary.receivedUnits
    || itemTotals.recorded !== summary.recordedUnits
    || itemTotals.remaining !== summary.remainingUnits) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Disposition summary totals do not match its item lines.",
      path: ["items"],
    });
  }
  if (!Number.isSafeInteger(summary.recordedUnits + summary.remainingUnits)
    || summary.receivedUnits !== summary.recordedUnits + summary.remainingUnits) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Disposition summary totals are inconsistent.",
      path: ["receivedUnits"],
    });
  }
  if (summary.fullyRecorded !== (summary.receivedUnits > 0 && summary.remainingUnits === 0)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "fullyRecorded is inconsistent with the disposition totals.",
      path: ["fullyRecorded"],
    });
  }
  if (summary.partiallyRecorded !== (summary.recordedUnits > 0 && summary.remainingUnits > 0)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "partiallyRecorded is inconsistent with the disposition totals.",
      path: ["partiallyRecorded"],
    });
  }
});

export const returnCaseInventoryTreatmentSummaryItemSchema = z.object({
  dispositionItemId: positiveSafeIntegerSchema,
  returnCaseItemId: positiveSafeIntegerSchema,
  treatment: returnCaseDispositionTreatmentSchema,
  quantity: positiveSafeIntegerSchema,
  warehouseLocationId: positiveSafeIntegerSchema.nullable(),
  inventoryTransactionId: positiveSafeIntegerSchema.nullable(),
  inventoryLotId: positiveSafeIntegerSchema.nullable(),
  applied: z.boolean(),
}).strict().superRefine((item, context) => {
  const hasSellableEvidence = item.warehouseLocationId !== null
    && item.inventoryTransactionId !== null
    && item.inventoryLotId !== null;
  const hasNoInventoryEvidence = item.warehouseLocationId === null
    && item.inventoryTransactionId === null
    && item.inventoryLotId === null;
  const evidenceIsCoherent = item.applied
    ? item.treatment === "restock_sellable" ? hasSellableEvidence : hasNoInventoryEvidence
    : hasNoInventoryEvidence;
  if (!evidenceIsCoherent) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Inventory treatment evidence is inconsistent with its state.",
      path: ["applied"],
    });
  }
});

export const returnCaseInventoryTreatmentSummarySchema = z.object({
  dispositionUnits: nonNegativeSafeIntegerSchema,
  appliedUnits: nonNegativeSafeIntegerSchema,
  remainingUnits: nonNegativeSafeIntegerSchema,
  fullyApplied: z.boolean(),
  partiallyApplied: z.boolean(),
  items: z.array(returnCaseInventoryTreatmentSummaryItemSchema),
}).strict().superRefine((summary, context) => {
  const seenIds = new Set<number>();
  let dispositionUnits = 0;
  let appliedUnits = 0;
  for (const [index, item] of summary.items.entries()) {
    if (seenIds.has(item.dispositionItemId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "An inventory treatment source may only appear once.",
        path: ["items", index, "dispositionItemId"],
      });
    }
    seenIds.add(item.dispositionItemId);
    dispositionUnits += item.quantity;
    if (item.applied) appliedUnits += item.quantity;
  }
  if (!Number.isSafeInteger(dispositionUnits)
    || !Number.isSafeInteger(appliedUnits)
    || dispositionUnits !== summary.dispositionUnits
    || appliedUnits !== summary.appliedUnits
    || summary.remainingUnits !== dispositionUnits - appliedUnits
    || summary.fullyApplied !== (dispositionUnits > 0 && summary.remainingUnits === 0)
    || summary.partiallyApplied !== (appliedUnits > 0 && summary.remainingUnits > 0)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Inventory treatment summary totals are inconsistent.",
      path: ["items"],
    });
  }
});

export const returnCaseActionPlanSchema = z.object({
  nextAction: returnCaseActionKindSchema.nullable(),
  receiptSummary: returnCaseReceiptSummarySchema,
  inspectionSummary: returnCaseInspectionSummarySchema.nullable(),
  dispositionSummary: returnCaseDispositionSummarySchema,
  inventoryTreatmentSummary: returnCaseInventoryTreatmentSummarySchema,
  actions: z.array(returnCaseActionSchema).length(
    returnCaseActionKindSchema.options.length,
  ),
}).strict().superRefine((plan, context) => {
  const seenKinds = new Set<string>();
  for (const [index, action] of plan.actions.entries()) {
    if (seenKinds.has(action.kind)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "An action kind may only appear once.",
        path: ["actions", index, "kind"],
      });
    }
    seenKinds.add(action.kind);
  }
  if (plan.nextAction !== null) {
    const next = plan.actions.find((action) => action.kind === plan.nextAction);
    if (!next || next.state !== "available") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "nextAction must identify a server-provided available action.",
        path: ["nextAction"],
      });
    }
  }
  const completionAction = plan.actions.find((action) => action.kind === "complete_inspection");
  if (completionAction?.state === "available" && plan.inspectionSummary?.status !== "in_progress") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "An available complete_inspection action requires an in-progress inspection summary.",
      path: ["inspectionSummary"],
    });
  }
});

export const returnCaseDetailItemSchema = z.object({
  id: positiveSafeIntegerSchema,
  wmsReturnItemId: positiveSafeIntegerSchema,
  omsOrderLineId: positiveSafeIntegerSchema.nullable(),
  wmsOrderItemId: positiveSafeIntegerSchema.nullable(),
  productVariantId: positiveSafeIntegerSchema.nullable(),
  externalLineItemId: nullableRequiredTextSchema,
  sku: nullableRequiredTextSchema,
  title: nullableTextSchema,
  quantity: positiveSafeIntegerSchema,
  expectedQuantity: positiveSafeIntegerSchema,
  receivedQuantity: nonNegativeSafeIntegerSchema,
  remainingQuantity: nonNegativeSafeIntegerSchema,
  receiptStatus: returnCaseReceiptStatusSchema,
  unitPaidPriceCents: nonNegativeSafeIntegerSchema,
  sourceLineTotalCents: nonNegativeSafeIntegerSchema,
  createdAt: dateTimeSchema,
}).strict().superRefine((item, context) => {
  if (!Number.isSafeInteger(item.receivedQuantity + item.remainingQuantity)
    || item.expectedQuantity !== item.receivedQuantity + item.remainingQuantity) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Item receipt quantities are inconsistent.",
      path: ["expectedQuantity"],
    });
  }
  const expectedStatus = item.remainingQuantity === 0
    ? "received"
    : item.receivedQuantity > 0
      ? "partially_received"
      : "expected";
  if (item.receiptStatus !== expectedStatus) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "receiptStatus is inconsistent with the item receipt quantities.",
      path: ["receiptStatus"],
    });
  }
});

const returnCaseEventSchema = z.object({
  id: positiveSafeIntegerSchema,
  eventType: requiredTextSchema,
  actor: requiredTextSchema,
  details: jsonValueSchema,
  occurredAt: dateTimeSchema,
  createdAt: dateTimeSchema,
}).strict();

export const returnCaseDetailSchema = z.object({
  recordOrigin: z.enum(["canonical", "legacy_dropship"]),
  recordKey: requiredTextSchema,
  legacyRmaId: positiveSafeIntegerSchema.nullable(),
  id: positiveSafeIntegerSchema,
  caseNumber: requiredTextSchema,
  sourceProvider: requiredTextSchema,
  sourceEventType: requiredTextSchema,
  sourceEventId: requiredTextSchema,
  businessContext: requiredTextSchema,
  channelId: positiveSafeIntegerSchema.nullable(),
  channelName: nullableRequiredTextSchema,
  vendorId: positiveSafeIntegerSchema.nullable(),
  vendorName: nullableRequiredTextSchema,
  storeConnectionId: positiveSafeIntegerSchema.nullable(),
  storeName: nullableRequiredTextSchema,
  omsOrderId: positiveSafeIntegerSchema.nullable(),
  omsOrderNumber: nullableRequiredTextSchema,
  wmsOrderId: positiveSafeIntegerSchema.nullable(),
  wmsOrderNumber: nullableRequiredTextSchema,
  wmsReturnId: positiveSafeIntegerSchema.nullable(),
  caseStatus: requiredTextSchema,
  approvalStatus: requiredTextSchema,
  logisticsStatus: requiredTextSchema,
  inspectionStatus: requiredTextSchema,
  customerRefundStatus: requiredTextSchema,
  vendorSettlementStatus: requiredTextSchema,
  openedAt: dateTimeSchema,
  closedAt: dateTimeSchema.nullable(),
  itemCount: nonNegativeSafeIntegerSchema,
  unitCount: nonNegativeSafeIntegerSchema,
  policyId: positiveSafeIntegerSchema,
  policyVersion: positiveSafeIntegerSchema,
  policySnapshot: jsonValueSchema,
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
  items: z.array(returnCaseDetailItemSchema),
  events: z.array(returnCaseEventSchema),
  actionPlan: returnCaseActionPlanSchema,
}).strict().superRefine((detail, context) => {
  if (detail.itemCount !== detail.items.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "itemCount does not match the returned item lines.",
      path: ["itemCount"],
    });
  }
  const totals = detail.items.reduce(
    (result, item) => ({
      expected: result.expected + item.expectedQuantity,
      received: result.received + item.receivedQuantity,
      remaining: result.remaining + item.remainingQuantity,
    }),
    { expected: 0, received: 0, remaining: 0 },
  );
  if (!Object.values(totals).every(Number.isSafeInteger)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Item receipt totals exceed the safe integer range.",
      path: ["items"],
    });
    return;
  }
  const summary = detail.actionPlan.receiptSummary;
  if (totals.expected !== summary.expectedUnits
    || totals.received !== summary.receivedUnits
    || totals.remaining !== summary.remainingUnits) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "The action-plan receipt summary does not match the item lines.",
      path: ["actionPlan", "receiptSummary"],
    });
  }
  const dispositionItems = detail.actionPlan.dispositionSummary.items;
  const detailItemsById = new Map(detail.items.map((item) => [item.id, item]));
  const dispositionAction = detail.actionPlan.actions.find(
    (action) => action.kind === "record_disposition",
  );
  const hasExplicitDispositionEvidenceConflict = dispositionItems.length === 0
    && dispositionAction?.state === "blocked"
    && dispositionAction.reasonCode === "RETURN_DISPOSITION_STATE_CONFLICT";
  if (dispositionItems.length !== detail.items.length && !hasExplicitDispositionEvidenceConflict) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "The disposition summary does not cover every return item.",
      path: ["actionPlan", "dispositionSummary", "items"],
    });
  }
  for (const [index, dispositionItem] of dispositionItems.entries()) {
    const detailItem = detailItemsById.get(dispositionItem.returnCaseItemId);
    if (!detailItem) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "The disposition summary contains an unknown return item.",
        path: ["actionPlan", "dispositionSummary", "items", index, "returnCaseItemId"],
      });
      continue;
    }
    if (detailItem.receivedQuantity !== dispositionItem.receivedQuantity) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "The disposition summary received quantity does not match the return item.",
        path: ["actionPlan", "dispositionSummary", "items", index, "receivedQuantity"],
      });
    }
  }
  const inventorySummary = detail.actionPlan.inventoryTreatmentSummary;
  const inventoryAction = detail.actionPlan.actions.find(
    (action) => action.kind === "apply_inventory_treatment",
  );
  const hasExplicitInventoryEvidenceConflict = inventorySummary.items.length === 0
    && inventoryAction?.state === "blocked"
    && inventoryAction.reasonCode === "RETURN_INVENTORY_TREATMENT_STATE_CONFLICT";
  if (!hasExplicitInventoryEvidenceConflict
    && inventorySummary.dispositionUnits !== detail.actionPlan.dispositionSummary.recordedUnits) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Inventory treatment sources do not match the recorded disposition quantity.",
      path: ["actionPlan", "inventoryTreatmentSummary"],
    });
  }
});

const notesSchema = z.string().trim().max(MAX_NOTES_LENGTH).nullable().optional()
  .transform((value) => value || null);
const idempotencyKeySchema = z.string().trim().min(1).max(MAX_IDEMPOTENCY_KEY_LENGTH);
const receiptLineInputSchema = z.object({
  returnCaseItemId: positiveSafeIntegerSchema,
  expectedCurrentReceivedQuantity: nonNegativeSafeIntegerSchema,
  quantityReceivedNow: positiveSafeIntegerSchema,
}).strict();

const dispositionLineInputSchema = z.object({
  returnCaseItemId: positiveSafeIntegerSchema,
  quantity: positiveSafeIntegerSchema,
  treatment: returnCaseDispositionTreatmentSchema,
  expectedCurrentReceivedQuantity: nonNegativeSafeIntegerSchema,
  expectedCurrentDisposedQuantity: nonNegativeSafeIntegerSchema,
}).strict().superRefine((line, context) => {
  const recordedAfterCommand = line.expectedCurrentDisposedQuantity + line.quantity;
  if (!Number.isSafeInteger(recordedAfterCommand)
    || line.expectedCurrentDisposedQuantity > line.expectedCurrentReceivedQuantity
    || recordedAfterCommand > line.expectedCurrentReceivedQuantity) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Disposition quantity exceeds the reviewed received quantity.",
      path: ["quantity"],
    });
  }
});
const inventoryTreatmentLineInputSchema = z.object({
  dispositionItemId: positiveSafeIntegerSchema,
  expectedTreatment: returnCaseDispositionTreatmentSchema,
  expectedQuantity: positiveSafeIntegerSchema,
  warehouseLocationId: positiveSafeIntegerSchema.nullable(),
}).strict().superRefine((line, context) => {
  if ((line.expectedTreatment === "restock_sellable") !== (line.warehouseLocationId !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Warehouse location does not match the treatment.", path: ["warehouseLocationId"] });
  }
});

export const recordReturnReceiptInputSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  lines: z.array(receiptLineInputSchema).min(1).max(MAX_RECEIPT_LINES),
  notes: notesSchema,
}).strict().superRefine((input, context) => {
  const seenIds = new Set<number>();
  for (const [index, line] of input.lines.entries()) {
    if (seenIds.has(line.returnCaseItemId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A return case item may only appear once.",
        path: ["lines", index, "returnCaseItemId"],
      });
    }
    seenIds.add(line.returnCaseItemId);
  }
});

export const startReturnInspectionInputSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  notes: notesSchema,
}).strict();

export const completeReturnInspectionInputSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  outcome: z.enum(["approved", "rejected"]),
  notes: notesSchema,
}).strict();

export const recordReturnDispositionInputSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  inspectionId: positiveSafeIntegerSchema.nullable(),
  lines: z.array(dispositionLineInputSchema).min(1).max(MAX_DISPOSITION_LINES),
  notes: notesSchema,
}).strict().superRefine((input, context) => {
  const seenIds = new Set<number>();
  for (const [index, line] of input.lines.entries()) {
    if (seenIds.has(line.returnCaseItemId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A return case item may only appear once.",
        path: ["lines", index, "returnCaseItemId"],
      });
    }
    seenIds.add(line.returnCaseItemId);
  }
});
export const applyReturnInventoryTreatmentInputSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  notes: notesSchema,
  lines: z.array(inventoryTreatmentLineInputSchema).min(1).max(MAX_INVENTORY_TREATMENT_LINES),
}).strict().superRefine((input, context) => {
  const seen = new Set<number>();
  for (const [index, line] of input.lines.entries()) {
    if (seen.has(line.dispositionItemId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "A disposition item may only appear once.", path: ["lines", index, "dispositionItemId"] });
    }
    seen.add(line.dispositionItemId);
  }
});

export const recordReturnReceiptResultSchema = z.object({
  commandType: z.literal("record_receipt"),
  caseId: positiveSafeIntegerSchema,
  caseNumber: requiredTextSchema,
  wmsReturnId: positiveSafeIntegerSchema,
  logisticsStatus: z.enum(["partially_received", "received"]),
  expectedUnits: positiveSafeIntegerSchema,
  receivedUnits: positiveSafeIntegerSchema,
  remainingUnits: nonNegativeSafeIntegerSchema,
  replayed: z.boolean(),
}).strict().superRefine((result, context) => {
  if (!Number.isSafeInteger(result.receivedUnits + result.remainingUnits)
    || result.expectedUnits !== result.receivedUnits + result.remainingUnits) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Receipt command totals are inconsistent.",
      path: ["expectedUnits"],
    });
  }
  const expectedStatus = result.remainingUnits === 0 ? "received" : "partially_received";
  if (result.logisticsStatus !== expectedStatus) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "logisticsStatus is inconsistent with the receipt command totals.",
      path: ["logisticsStatus"],
    });
  }
});

export const startReturnInspectionResultSchema = z.object({
  commandType: z.literal("start_inspection"),
  caseId: positiveSafeIntegerSchema,
  caseNumber: requiredTextSchema,
  inspectionId: positiveSafeIntegerSchema,
  inspectionStatus: z.literal("in_progress"),
  startedAt: dateTimeSchema,
  replayed: z.boolean(),
}).strict();

export const completeReturnInspectionResultSchema = z.object({
  commandType: z.literal("complete_inspection"),
  caseId: positiveSafeIntegerSchema,
  caseNumber: requiredTextSchema,
  inspectionId: positiveSafeIntegerSchema,
  inspectionStatus: z.enum(["approved", "rejected"]),
  completedAt: dateTimeSchema,
  replayed: z.boolean(),
}).strict();

const returnDispositionResultLineSchema = z.object({
  returnCaseItemId: positiveSafeIntegerSchema,
  treatment: returnCaseDispositionTreatmentSchema,
  quantity: positiveSafeIntegerSchema,
}).strict();

export const recordReturnDispositionResultSchema = z.object({
  commandType: z.literal("record_disposition"),
  caseId: positiveSafeIntegerSchema,
  caseNumber: requiredTextSchema,
  dispositionId: positiveSafeIntegerSchema,
  inspectionId: positiveSafeIntegerSchema.nullable(),
  inspectionResolution: z.enum(["approved", "rejected", "not_required"]),
  lines: z.array(returnDispositionResultLineSchema).min(1).max(MAX_DISPOSITION_LINES),
  dispositionSummary: returnCaseDispositionSummarySchema,
  recordedAt: dateTimeSchema,
  replayed: z.boolean(),
}).strict().superRefine((result, context) => {
  const hasInspection = result.inspectionId !== null;
  const resolutionHasInspection = result.inspectionResolution !== "not_required";
  if (hasInspection !== resolutionHasInspection) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Disposition inspection evidence is inconsistent with its resolution.",
      path: ["inspectionResolution"],
    });
  }
  const seenIds = new Set<number>();
  for (const [index, line] of result.lines.entries()) {
    if (seenIds.has(line.returnCaseItemId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A disposition result item may only appear once.",
        path: ["lines", index, "returnCaseItemId"],
      });
    }
    seenIds.add(line.returnCaseItemId);
    const summaryItem = result.dispositionSummary.items.find(
      (item) => item.returnCaseItemId === line.returnCaseItemId,
    );
    const recordedTreatmentQuantity = line.treatment === "restock_sellable"
      ? summaryItem?.restockSellableQuantity
      : summaryItem?.holdNonSellableQuantity;
    if (!summaryItem || recordedTreatmentQuantity === undefined
      || recordedTreatmentQuantity < line.quantity) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Disposition summary does not reflect the recorded result line.",
        path: ["dispositionSummary", "items"],
      });
    }
  }
});
const returnInventoryTreatmentResultLineSchema = z.object({
  dispositionItemId: positiveSafeIntegerSchema,
  returnCaseItemId: positiveSafeIntegerSchema,
  productVariantId: positiveSafeIntegerSchema.nullable(),
  treatment: returnCaseDispositionTreatmentSchema,
  quantity: positiveSafeIntegerSchema,
  warehouseLocationId: positiveSafeIntegerSchema.nullable(),
  inventoryTransactionId: positiveSafeIntegerSchema.nullable(),
  inventoryLotId: positiveSafeIntegerSchema.nullable(),
}).strict().superRefine((line, context) => {
  const coherent = line.treatment === "restock_sellable"
    ? line.productVariantId !== null && line.warehouseLocationId !== null
      && line.inventoryTransactionId !== null && line.inventoryLotId !== null
    : line.productVariantId === null && line.warehouseLocationId === null
      && line.inventoryTransactionId === null && line.inventoryLotId === null;
  if (!coherent) context.addIssue({ code: z.ZodIssueCode.custom, message: "Inventory result evidence is inconsistent.", path: ["treatment"] });
});
export const applyReturnInventoryTreatmentResultSchema = z.object({
  commandType: z.literal("apply_inventory_treatment"),
  caseId: positiveSafeIntegerSchema,
  caseNumber: requiredTextSchema,
  inventoryTreatmentId: positiveSafeIntegerSchema,
  lines: z.array(returnInventoryTreatmentResultLineSchema).min(1).max(MAX_INVENTORY_TREATMENT_LINES),
  inventoryTreatmentSummary: returnCaseInventoryTreatmentSummarySchema,
  appliedAt: dateTimeSchema,
  replayed: z.boolean(),
}).strict();

export type ReturnCaseActionKind = z.infer<typeof returnCaseActionKindSchema>;
export type ReturnCaseAction = z.infer<typeof returnCaseActionSchema>;
export type ReturnCaseActionPlan = z.infer<typeof returnCaseActionPlanSchema>;
export type ReturnCaseDispositionSummary = z.infer<typeof returnCaseDispositionSummarySchema>;
export type ReturnCaseInventoryTreatmentSummary = z.infer<typeof returnCaseInventoryTreatmentSummarySchema>;
export type ReturnCaseDispositionTreatment = z.infer<typeof returnCaseDispositionTreatmentSchema>;
export type ReturnCaseDetailItem = z.infer<typeof returnCaseDetailItemSchema>;
export type ReturnCaseDetail = z.infer<typeof returnCaseDetailSchema>;
export type RecordReturnReceiptInput = z.input<typeof recordReturnReceiptInputSchema>;
export type RecordReturnReceiptResult = z.infer<typeof recordReturnReceiptResultSchema>;
export type StartReturnInspectionInput = z.input<typeof startReturnInspectionInputSchema>;
export type StartReturnInspectionResult = z.infer<typeof startReturnInspectionResultSchema>;
export type CompleteReturnInspectionInput = z.input<typeof completeReturnInspectionInputSchema>;
export type CompleteReturnInspectionResult = z.infer<typeof completeReturnInspectionResultSchema>;
export type RecordReturnDispositionInput = z.input<typeof recordReturnDispositionInputSchema>;
export type RecordReturnDispositionResult = z.infer<typeof recordReturnDispositionResultSchema>;
export type ApplyReturnInventoryTreatmentInput = z.input<typeof applyReturnInventoryTreatmentInputSchema>;
export type ApplyReturnInventoryTreatmentResult = z.infer<typeof applyReturnInventoryTreatmentResultSchema>;
export type ReturnCaseOperationResult =
  | RecordReturnReceiptResult
  | StartReturnInspectionResult
  | CompleteReturnInspectionResult
  | RecordReturnDispositionResult
  | ApplyReturnInventoryTreatmentResult;
export const returnWarehouseLocationSchema = z.object({
  id: positiveSafeIntegerSchema,
  code: requiredTextSchema,
  name: nullableTextSchema.optional().default(null),
  warehouseId: positiveSafeIntegerSchema.nullable(),
  isActive: z.union([z.literal(0), z.literal(1)]),
  isPickable: z.union([z.literal(0), z.literal(1)]),
  cycleCountFreezeId: positiveSafeIntegerSchema.nullable(),
}).passthrough();
export type ReturnWarehouseLocation = z.infer<typeof returnWarehouseLocationSchema>;
export const returnVariantBinAssignmentSchema = z.object({
  productVariantId: positiveSafeIntegerSchema,
  assignedLocationCode: nullableRequiredTextSchema,
  assignedLocationId: positiveSafeIntegerSchema.nullable(),
  slotStatus: z.enum(["valid", "unassigned", "invalid", "duplicate"]),
  slotIssue: nullableRequiredTextSchema,
  assignmentCount: nonNegativeSafeIntegerSchema,
  validAssignmentCount: nonNegativeSafeIntegerSchema,
}).passthrough();
export type ReturnVariantBinAssignment = z.infer<typeof returnVariantBinAssignmentSchema>;

export type ReturnCaseAdminApiErrorCode =
  | "RETURN_CASE_CLIENT_INPUT_INVALID"
  | "RETURN_CASE_REQUEST_FAILED"
  | "RETURN_CASE_RESPONSE_INVALID";

export class ReturnCaseAdminApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(input: {
    code: string;
    message: string;
    status: number;
    context?: Readonly<Record<string, unknown>>;
  }) {
    super(input.message);
    this.name = "ReturnCaseAdminApiError";
    this.code = input.code;
    this.status = input.status;
    this.context = Object.freeze({ ...(input.context ?? {}) });
  }
}

export type ReturnCaseAdminTransport = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export async function getReturnCaseDetail(
  caseId: number,
  transport: ReturnCaseAdminTransport = fetch,
): Promise<ReturnCaseDetail> {
  const parsedCaseId = parseCaseId(caseId);
  return requestJson(
    `/api/returns/admin/cases/${parsedCaseId}`,
    { method: "GET", credentials: "include", headers: { Accept: "application/json" } },
    returnCaseDetailSchema,
    transport,
  );
}

export async function getReturnWarehouseLocations(
  transport: ReturnCaseAdminTransport = fetch,
): Promise<ReturnWarehouseLocation[]> {
  return requestJson(
    "/api/warehouse/locations",
    { method: "GET", credentials: "include", headers: { Accept: "application/json" } },
    z.array(returnWarehouseLocationSchema),
    transport,
  );
}

export async function getReturnVariantBinAssignments(
  productVariantIds: readonly number[],
  transport: ReturnCaseAdminTransport = fetch,
): Promise<ReturnVariantBinAssignment[]> {
  const parsed = z.array(positiveSafeIntegerSchema)
    .min(1)
    .max(MAX_BIN_ASSIGNMENT_VARIANT_IDS)
    .safeParse(productVariantIds);
  if (!parsed.success) throw inputError(parsed.error);
  const normalized = [...new Set(parsed.data)].sort((left, right) => left - right);
  const requestedIds = new Set(normalized);
  const responseSchema = z.array(returnVariantBinAssignmentSchema).superRefine((rows, context) => {
    rows.forEach((row, index) => {
      if (!requestedIds.has(row.productVariantId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Bin assignment response contains an unrequested product variant.",
          path: [index, "productVariantId"],
        });
      }
    });
  });
  return requestJson(
    `/api/bin-assignments?variantIds=${normalized.join(",")}`,
    { method: "GET", credentials: "include", headers: { Accept: "application/json" } },
    responseSchema,
    transport,
  );
}

export async function recordReturnReceipt(
  caseId: number,
  input: RecordReturnReceiptInput,
  transport: ReturnCaseAdminTransport = fetch,
): Promise<RecordReturnReceiptResult> {
  const parsedCaseId = parseCaseId(caseId);
  const parsedInput = parseOutboundInput(recordReturnReceiptInputSchema, input);
  const body = {
    ...parsedInput,
    lines: [...parsedInput.lines].sort(
      (left, right) => left.returnCaseItemId - right.returnCaseItemId,
    ),
  };
  return requestJson(
    `/api/returns/admin/cases/${parsedCaseId}/receipt`,
    jsonPost(body),
    recordReturnReceiptResultSchema,
    transport,
  );
}

export async function startReturnInspection(
  caseId: number,
  input: StartReturnInspectionInput,
  transport: ReturnCaseAdminTransport = fetch,
): Promise<StartReturnInspectionResult> {
  const parsedCaseId = parseCaseId(caseId);
  const parsedInput = parseOutboundInput(startReturnInspectionInputSchema, input);
  return requestJson(
    `/api/returns/admin/cases/${parsedCaseId}/inspections/start`,
    jsonPost(parsedInput),
    startReturnInspectionResultSchema,
    transport,
  );
}

export async function completeReturnInspection(
  caseId: number,
  inspectionId: number,
  input: CompleteReturnInspectionInput,
  transport: ReturnCaseAdminTransport = fetch,
): Promise<CompleteReturnInspectionResult> {
  const parsedCaseId = parseCaseId(caseId);
  const parsedInspectionId = parseCaseId(inspectionId);
  const parsedInput = parseOutboundInput(completeReturnInspectionInputSchema, input);
  const correlatedResultSchema = completeReturnInspectionResultSchema.superRefine((result, context) => {
    if (result.caseId !== parsedCaseId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Completion response caseId does not match the requested return case.",
        path: ["caseId"],
      });
    }
    if (result.inspectionId !== parsedInspectionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Completion response inspectionId does not match the requested inspection.",
        path: ["inspectionId"],
      });
    }
  });
  return requestJson(
    `/api/returns/admin/cases/${parsedCaseId}/inspections/${parsedInspectionId}/complete`,
    jsonPost(parsedInput),
    correlatedResultSchema,
    transport,
  );
}

export async function recordReturnDisposition(
  caseId: number,
  input: RecordReturnDispositionInput,
  transport: ReturnCaseAdminTransport = fetch,
): Promise<RecordReturnDispositionResult> {
  const parsedCaseId = parseCaseId(caseId);
  const parsedInput = parseOutboundInput(recordReturnDispositionInputSchema, input);
  const body = {
    ...parsedInput,
    lines: [...parsedInput.lines].sort(
      (left, right) => left.returnCaseItemId - right.returnCaseItemId,
    ),
  };
  const correlatedResultSchema = recordReturnDispositionResultSchema.superRefine((result, context) => {
    if (result.caseId !== parsedCaseId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Disposition response caseId does not match the requested return case.",
        path: ["caseId"],
      });
    }
    if (result.inspectionId !== body.inspectionId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Disposition response inspectionId does not match the reviewed inspection.",
        path: ["inspectionId"],
      });
    }
    const resultLines = [...result.lines].sort(
      (left, right) => left.returnCaseItemId - right.returnCaseItemId,
    );
    if (resultLines.length !== body.lines.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Disposition response lines do not match the submitted command.",
        path: ["lines"],
      });
      return;
    }
    for (const [index, expectedLine] of body.lines.entries()) {
      const resultLine = resultLines[index];
      if (resultLine.returnCaseItemId !== expectedLine.returnCaseItemId
        || resultLine.treatment !== expectedLine.treatment
        || resultLine.quantity !== expectedLine.quantity) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Disposition response line does not match the submitted command.",
          path: ["lines", index],
        });
      }
      const summaryItem = result.dispositionSummary.items.find(
        (item) => item.returnCaseItemId === expectedLine.returnCaseItemId,
      );
      const expectedRecordedQuantity =
        expectedLine.expectedCurrentDisposedQuantity + expectedLine.quantity;
      const expectedRemainingQuantity =
        expectedLine.expectedCurrentReceivedQuantity - expectedRecordedQuantity;
      if (!summaryItem
        || !Number.isSafeInteger(expectedRecordedQuantity)
        || expectedRemainingQuantity < 0
        || summaryItem.receivedQuantity !== expectedLine.expectedCurrentReceivedQuantity
        || summaryItem.recordedQuantity !== expectedRecordedQuantity
        || summaryItem.remainingQuantity !== expectedRemainingQuantity) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Disposition summary does not match the submitted optimistic evidence.",
          path: ["dispositionSummary", "items"],
        });
      }
    }
  });
  return requestJson(
    `/api/returns/admin/cases/${parsedCaseId}/dispositions`,
    jsonPost(body),
    correlatedResultSchema,
    transport,
  );
}

export async function applyReturnInventoryTreatment(
  caseId: number,
  input: ApplyReturnInventoryTreatmentInput,
  transport: ReturnCaseAdminTransport = fetch,
): Promise<ApplyReturnInventoryTreatmentResult> {
  const parsedCaseId = parseCaseId(caseId);
  const parsedInput = parseOutboundInput(applyReturnInventoryTreatmentInputSchema, input);
  const body = {
    ...parsedInput,
    lines: [...parsedInput.lines].sort((left, right) => left.dispositionItemId - right.dispositionItemId),
  };
  const correlatedResultSchema = applyReturnInventoryTreatmentResultSchema.superRefine((result, context) => {
    if (result.caseId !== parsedCaseId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Inventory treatment response caseId does not match the request.", path: ["caseId"] });
    }
    const resultLines = [...result.lines].sort((left, right) => left.dispositionItemId - right.dispositionItemId);
    if (resultLines.length !== body.lines.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Inventory treatment response lines do not match the request.", path: ["lines"] });
      return;
    }
    for (const [index, expected] of body.lines.entries()) {
      const actual = resultLines[index];
      if (actual.dispositionItemId !== expected.dispositionItemId
        || actual.treatment !== expected.expectedTreatment
        || actual.quantity !== expected.expectedQuantity
        || actual.warehouseLocationId !== expected.warehouseLocationId) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Inventory treatment response line does not match the request.", path: ["lines", index] });
      }
      const summaryItem = result.inventoryTreatmentSummary.items.find(
        (item) => item.dispositionItemId === expected.dispositionItemId,
      );
      if (!summaryItem || !summaryItem.applied
        || summaryItem.treatment !== expected.expectedTreatment
        || summaryItem.quantity !== expected.expectedQuantity
        || summaryItem.warehouseLocationId !== expected.warehouseLocationId) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Inventory treatment summary does not match the request.", path: ["inventoryTreatmentSummary", "items"] });
      }
    }
  });
  return requestJson(
    `/api/returns/admin/cases/${parsedCaseId}/inventory-treatments`,
    jsonPost(body),
    correlatedResultSchema,
    transport,
  );
}

export function createReturnCaseIdempotencyKey(command: ReturnCaseActionKind): string {
  if (!globalThis.crypto || typeof globalThis.crypto.randomUUID !== "function") {
    throw new ReturnCaseAdminApiError({
      code: "RETURN_CASE_CLIENT_INPUT_INVALID",
      message: "A secure idempotency key could not be generated.",
      status: 0,
      context: { field: "idempotencyKey" },
    });
  }
  return `returns-admin:${command}:${globalThis.crypto.randomUUID()}`;
}

function parseCaseId(caseId: number): number {
  const parsed = positiveSafeIntegerSchema.safeParse(caseId);
  if (!parsed.success) throw inputError(parsed.error);
  return parsed.data;
}

function parseOutboundInput<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  input: unknown,
): z.output<TSchema> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  return parsed.data;
}

function inputError(error: z.ZodError): ReturnCaseAdminApiError {
  return new ReturnCaseAdminApiError({
    code: "RETURN_CASE_CLIENT_INPUT_INVALID",
    message: "Return case operation input is invalid.",
    status: 0,
    context: { issues: mapIssues(error) },
  });
}

function jsonPost(body: unknown): RequestInit {
  return {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function requestJson<TSchema extends z.ZodTypeAny>(
  url: string,
  init: RequestInit,
  responseSchema: TSchema,
  transport: ReturnCaseAdminTransport,
): Promise<z.output<TSchema>> {
  let response: Response;
  try {
    response = await transport(url, init);
  } catch (cause) {
    throw new ReturnCaseAdminApiError({
      code: "RETURN_CASE_REQUEST_FAILED",
      message: "Return case request failed before a response was received.",
      status: 0,
      context: { causeName: cause instanceof Error ? cause.name : "UnknownError" },
    });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (!response.ok) {
      throw new ReturnCaseAdminApiError({
        code: "RETURN_CASE_REQUEST_FAILED",
        message: `Return case request failed (${response.status}).`,
        status: response.status,
      });
    }
    throw new ReturnCaseAdminApiError({
      code: "RETURN_CASE_RESPONSE_INVALID",
      message: "Return case request returned invalid JSON.",
      status: response.status,
    });
  }

  if (!response.ok) throw errorFromResponse(body, response.status);

  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) {
    throw new ReturnCaseAdminApiError({
      code: "RETURN_CASE_RESPONSE_INVALID",
      message: "Return case request returned an invalid response.",
      status: response.status,
      context: { issues: mapIssues(parsed.error) },
    });
  }
  return parsed.data;
}

const errorResponseSchema = z.object({
  error: z.object({
    code: z.string().trim().min(1).max(160),
    message: z.string().trim().min(1).max(2_000),
    context: z.record(jsonValueSchema).optional(),
  }).strict(),
}).strict();

function errorFromResponse(body: unknown, status: number): ReturnCaseAdminApiError {
  const parsed = errorResponseSchema.safeParse(body);
  if (!parsed.success) {
    return new ReturnCaseAdminApiError({
      code: "RETURN_CASE_REQUEST_FAILED",
      message: `Return case request failed (${status}).`,
      status,
    });
  }
  return new ReturnCaseAdminApiError({
    code: parsed.data.error.code,
    message: parsed.data.error.message,
    status,
    context: parsed.data.error.context,
  });
}

function mapIssues(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}
