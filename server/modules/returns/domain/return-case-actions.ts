import {
  returnApprovalAuthorities,
  returnDestinations,
  returnDispositionTreatments,
  returnInspectionOwners,
  returnInspectionRequirements,
  returnLabelProviders,
  returnPolicyScopeKinds,
  returnRefundAuthorities,
  returnShippingPayers,
  returnVendorSettlementTriggers,
  type ReturnBusinessContext,
  type ReturnInspectionOwner,
  type ReturnInspectionRequirement,
  type ReturnDestination,
  type ReturnDispositionTreatment,
} from "@shared/schema";
import type { ReturnCaseLifecycle, ReturnPolicySnapshot } from "./return-case";

const ZERO_RECEIPT_LOGISTICS_STATUSES = new Set([
  "awaiting_return",
  "label_ready",
  "in_transit",
  "delivered",
]);

export const returnCaseActionKinds = [
  "record_receipt",
  "start_inspection",
  "complete_inspection",
  "record_disposition",
  "apply_inventory_treatment",
  "issue_customer_refund",
  "settle_vendor_account",
] as const;
export type ReturnCaseActionKind = typeof returnCaseActionKinds[number];
export type ReturnCaseActionState = "available" | "blocked" | "completed" | "not_applicable";

export interface ReturnCaseAction {
  kind: ReturnCaseActionKind;
  label: string;
  description: string;
  state: ReturnCaseActionState;
  reasonCode: string | null;
}

export interface ReturnPolicySnapshotFacts extends ReturnPolicySnapshot {
  returnDestination: ReturnDestination;
  inspectionRequirement: ReturnInspectionRequirement;
  inspectionOwner: ReturnInspectionOwner;
}

export interface ReturnReceiptItemFacts {
  returnCaseItemId: number | null;
  wmsReturnItemId: number;
  caseExpectedQuantity: number | null;
  wmsExpectedQuantity: number;
  wmsReceivedQuantity: number;
  wmsStatus: string;
}

export interface ReturnReceiptFacts {
  wmsReturnId: number;
  wmsStatus: string;
  receivedAt: Date | null;
  restocked: boolean;
  canonicalItemCount: number;
  items: ReturnReceiptItemFacts[];
}

export interface ReturnInspectionFacts {
  inspectionId: number;
  status: "in_progress" | "approved" | "rejected" | "cancelled";
  startedAt: Date;
  startedBy: string;
  completedAt: Date | null;
  completedBy: string | null;
}

export interface ReturnDispositionLineFacts {
  dispositionItemId: number;
  dispositionId: number;
  returnCaseItemId: number;
  treatment: ReturnDispositionTreatment;
  quantity: number;
}

export interface ReturnDispositionFacts {
  recordCount: number;
  lines: ReturnDispositionLineFacts[];
}

export interface ReturnInventoryTreatmentLineFacts {
  dispositionItemId: number;
  returnCaseItemId: number;
  treatment: ReturnDispositionTreatment;
  quantity: number;
  warehouseLocationId: number | null;
  inventoryTransactionId: number | null;
  inventoryLotId: number | null;
}

export interface ReturnInventoryTreatmentFacts {
  recordCount: number;
  lines: ReturnInventoryTreatmentLineFacts[];
}

export interface ReturnCaseReceiptSummary {
  expectedUnits: number;
  receivedUnits: number;
  remainingUnits: number;
  fullyReceived: boolean;
  partiallyReceived: boolean;
}

export interface ReturnCaseDispositionItemSummary {
  returnCaseItemId: number;
  receivedQuantity: number;
  restockSellableQuantity: number;
  holdNonSellableQuantity: number;
  recordedQuantity: number;
  remainingQuantity: number;
}

export interface ReturnCaseDispositionSummary {
  receivedUnits: number;
  recordedUnits: number;
  remainingUnits: number;
  fullyRecorded: boolean;
  partiallyRecorded: boolean;
  items: ReturnCaseDispositionItemSummary[];
}

export interface ReturnCaseInventoryTreatmentItemSummary extends ReturnInventoryTreatmentLineFacts {
  applied: boolean;
}

export interface ReturnCaseInventoryTreatmentSummary {
  dispositionUnits: number;
  appliedUnits: number;
  remainingUnits: number;
  fullyApplied: boolean;
  partiallyApplied: boolean;
  items: ReturnCaseInventoryTreatmentItemSummary[];
}
export interface ReturnCaseActionContext {
  businessContext: ReturnBusinessContext;
  channelProvider: string | null;
  vendorId: number | null;

  lifecycle: ReturnCaseLifecycle;
  policy: ReturnPolicySnapshotFacts | null;
  receipt: ReturnReceiptFacts | null;
  inspection: ReturnInspectionFacts | null;
  disposition: ReturnDispositionFacts | null;
  inventoryTreatment: ReturnInventoryTreatmentFacts | null;
  conditionalInspectionDecision: "required" | "waived" | null;
}

export interface ReturnCaseActionPlan {
  nextAction: ReturnCaseActionKind | null;
  receiptSummary: ReturnCaseReceiptSummary;
  inspectionSummary: ReturnInspectionFacts | null;
  actions: ReturnCaseAction[];
  dispositionSummary: ReturnCaseDispositionSummary;
  inventoryTreatmentSummary: ReturnCaseInventoryTreatmentSummary;
}

interface ReceiptAnalysis {
  summary: ReturnCaseReceiptSummary;
  blocker: string | null;
}

interface DispositionAnalysis {
  summary: ReturnCaseDispositionSummary;
  blocker: string | null;
}
interface InventoryTreatmentAnalysis {
  summary: ReturnCaseInventoryTreatmentSummary;
  blocker: string | null;
}
export class ReturnCaseActionDomainError extends Error {
  constructor(

    public readonly code: string,
    message: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ReturnCaseActionDomainError";
  }
}

export function parseReturnPolicySnapshot(value: unknown): ReturnPolicySnapshotFacts {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidPolicy("Policy snapshot must be an object.");
  }
  const row = value as Record<string, unknown>;
  const returnDestination = readEnum(row.returnDestination, returnDestinations, "returnDestination");
  const inspectionRequirement = readEnum(
    row.inspectionRequirement,
    returnInspectionRequirements,
    "inspectionRequirement",
  );
  const inspectionOwner = readEnum(row.inspectionOwner, returnInspectionOwners, "inspectionOwner");
  return {
    id: readPositiveInteger(row.id, "id"),
    name: readRequiredText(row.name, "name"),
    version: readPositiveInteger(row.version, "version"),
    scopeKind: readEnum(row.scopeKind, returnPolicyScopeKinds, "scopeKind"),
    scopeKey: readRequiredText(row.scopeKey, "scopeKey"),
    returnWindowDays: readNonNegativeInteger(row.returnWindowDays, "returnWindowDays"),
    returnDestination,
    approvalAuthority: readEnum(row.approvalAuthority, returnApprovalAuthorities, "approvalAuthority"),
    labelProvider: readEnum(row.labelProvider, returnLabelProviders, "labelProvider"),
    returnShippingPayer: readEnum(row.returnShippingPayer, returnShippingPayers, "returnShippingPayer"),
    inspectionRequirement,
    inspectionOwner,
    customerRefundAuthority: readEnum(
      row.customerRefundAuthority,
      returnRefundAuthorities,
      "customerRefundAuthority",
    ),
    vendorSettlementTrigger: readEnum(
      row.vendorSettlementTrigger,
      returnVendorSettlementTriggers,
      "vendorSettlementTrigger",
    ),
    returnlessRefundAllowed: readBoolean(row.returnlessRefundAllowed, "returnlessRefundAllowed"),
  };
}

// Computes operator actions only from persisted canonical, WMS, policy, and
// inspection evidence. Callers render this plan and never recreate its rules.
export function deriveReturnCaseActionPlan(context: ReturnCaseActionContext): ReturnCaseActionPlan {
  const receipt = analyzeReceipt(context);
  const disposition = analyzeDisposition(context);
  const inventoryTreatment = analyzeInventoryTreatment(context, disposition);
  const actions = [
    deriveReceiptAction(context, receipt),
    deriveInspectionAction(context, receipt),
    deriveCompleteInspectionAction(context, receipt),
    deriveDispositionAction(context, receipt, disposition),
    deriveInventoryTreatmentAction(context, receipt, disposition, inventoryTreatment),
    deriveCustomerRefundAction(context, disposition, inventoryTreatment),
    deriveVendorSettlementAction(context, disposition, inventoryTreatment),
  ];
  return {
    nextAction: actions.find((action) => action.state === "available")?.kind ?? null,
    receiptSummary: receipt.summary,
    inspectionSummary: cloneInspectionSummary(context.inspection),
    dispositionSummary: disposition.summary,
    inventoryTreatmentSummary: inventoryTreatment.summary,
    actions,
  };
}

function deriveReceiptAction(
  context: ReturnCaseActionContext,
  receipt: ReceiptAnalysis,
): ReturnCaseAction {
  const base = {
    kind: "record_receipt" as const,
    label: "Record returned items received",
    description: "Record physical receipt against the expected WMS return. Inventory remains unavailable until a later inventory-treatment action is applied.",
  };
  if (!context.policy) return blocked(base, "RETURN_POLICY_SNAPSHOT_INVALID");
  if (context.policy.returnDestination !== "card_shellz") {
    return notApplicable(base, "RETURN_DESTINATION_EXTERNAL");
  }
  if (context.lifecycle.caseStatus !== "open") return blocked(base, "RETURN_CASE_NOT_OPEN");
  if (context.lifecycle.approvalStatus !== "approved") return blocked(base, "RETURN_CASE_NOT_APPROVED");
  if (receipt.blocker) return blocked(base, receipt.blocker);
  if (receipt.summary.fullyReceived) return completed(base);
  return available(base);
}

function deriveInspectionAction(
  context: ReturnCaseActionContext,
  receipt: ReceiptAnalysis,
): ReturnCaseAction {
  const base = {
    kind: "start_inspection" as const,
    label: "Begin inspection",
    description: "Begin inspection of the received items. This does not restock inventory, issue a refund, or settle a vendor balance.",
  };
  const policyFailure = deriveInspectionPolicyFailure(context);
  if (policyFailure) return applyInspectionPrerequisiteFailure(base, policyFailure);

  const inspection = context.inspection;
  if (inspection && isCoherentTerminalInspection(context, inspection)) return completed(base);
  if ((inspection && !isCoherentInProgressInspection(context, inspection))
    || (!inspection && context.lifecycle.inspectionStatus !== "pending")) {
    return blocked(base, "RETURN_INSPECTION_STATE_CONFLICT");
  }

  const operationalFailure = deriveInspectionOperationalFailure(context, receipt);
  if (operationalFailure) return applyInspectionPrerequisiteFailure(base, operationalFailure);
  return inspection ? completed(base) : available(base);
}

function deriveCompleteInspectionAction(
  context: ReturnCaseActionContext,
  receipt: ReceiptAnalysis,
): ReturnCaseAction {
  const base = {
    kind: "complete_inspection" as const,
    label: "Complete inspection",
    description: "Record the inspection as approved or rejected. This does not restock inventory, issue a refund, or settle a vendor balance.",
  };
  const policyFailure = deriveInspectionPolicyFailure(context);
  if (policyFailure) return applyInspectionPrerequisiteFailure(base, policyFailure);

  const inspection = context.inspection;
  if (inspection && isCoherentTerminalInspection(context, inspection)) return completed(base);
  if ((inspection && !isCoherentInProgressInspection(context, inspection))
    || (!inspection && context.lifecycle.inspectionStatus !== "pending")) {
    return blocked(base, "RETURN_INSPECTION_STATE_CONFLICT");
  }

  const operationalFailure = deriveInspectionOperationalFailure(context, receipt);
  if (operationalFailure) return applyInspectionPrerequisiteFailure(base, operationalFailure);
  return inspection ? available(base) : blocked(base, "RETURN_INSPECTION_NOT_STARTED");
}

interface InspectionPrerequisiteFailure {
  state: "blocked" | "not_applicable";
  reasonCode: string;
}

function deriveDispositionAction(
  context: ReturnCaseActionContext,
  receipt: ReceiptAnalysis,
  disposition: DispositionAnalysis,
): ReturnCaseAction {
  const base = {
    kind: "record_disposition" as const,
    label: "Resolve returned items",
    description: "Record physical treatment intent for received units. This does not restock inventory, issue a refund, settle a vendor balance, or close the return.",
  };
  if (!context.policy) return blocked(base, "RETURN_POLICY_SNAPSHOT_INVALID");
  if (disposition.blocker) return blocked(base, disposition.blocker);
  if (context.policy.returnDestination !== "card_shellz") {
    return notApplicable(base, "RETURN_DESTINATION_EXTERNAL");
  }

  // Once complete, immutable disposition evidence remains complete even if a
  // later action closes the case or applies the recorded inventory treatment.
  const receiptWithoutAppliedRestock = context.receipt?.restocked
    ? analyzeReceipt({ ...context, receipt: { ...context.receipt, restocked: false } })
    : receipt;
  if (disposition.summary.fullyRecorded
    && receiptWithoutAppliedRestock.blocker === null
    && receiptWithoutAppliedRestock.summary.fullyReceived) {
    const inspectionBlocker = deriveDispositionInspectionBlocker(context);
    if (inspectionBlocker) return blocked(base, inspectionBlocker);
    return completed(base);
  }

  if (context.lifecycle.caseStatus !== "open") return blocked(base, "RETURN_CASE_NOT_OPEN");
  if (context.lifecycle.approvalStatus !== "approved") return blocked(base, "RETURN_CASE_NOT_APPROVED");
  if (receipt.blocker) return blocked(base, receipt.blocker);
  if (!receipt.summary.fullyReceived || context.lifecycle.logisticsStatus !== "received") {
    return blocked(base, "RETURN_NOT_FULLY_RECEIVED");
  }
  const inspectionBlocker = deriveDispositionInspectionBlocker(context);
  if (inspectionBlocker) return blocked(base, inspectionBlocker);

  return available(base);
}

function deriveInventoryTreatmentAction(
  context: ReturnCaseActionContext,
  receipt: ReceiptAnalysis,
  disposition: DispositionAnalysis,
  inventoryTreatment: InventoryTreatmentAnalysis,
): ReturnCaseAction {
  const base = {
    kind: "apply_inventory_treatment" as const,
    label: "Apply inventory treatment",
    description: "Apply recorded treatment decisions. Sellable units enter inventory at the selected pickable location; held units remain outside sellable inventory.",
  };
  if (!context.policy) return blocked(base, "RETURN_POLICY_SNAPSHOT_INVALID");
  if (context.policy.returnDestination !== "card_shellz") {
    return notApplicable(base, "RETURN_DESTINATION_EXTERNAL");
  }
  if (disposition.blocker) return blocked(base, disposition.blocker);
  if (inventoryTreatment.blocker) return blocked(base, inventoryTreatment.blocker);
  if (inventoryTreatment.summary.fullyApplied) return completed(base);
  if (context.lifecycle.caseStatus !== "open") return blocked(base, "RETURN_CASE_NOT_OPEN");
  if (context.lifecycle.approvalStatus !== "approved") return blocked(base, "RETURN_CASE_NOT_APPROVED");
  if (receipt.blocker) return blocked(base, receipt.blocker);
  if (!receipt.summary.fullyReceived || context.lifecycle.logisticsStatus !== "received") {
    return blocked(base, "RETURN_NOT_FULLY_RECEIVED");
  }
  if (!disposition.summary.fullyRecorded) {
    return blocked(base, "RETURN_DISPOSITION_NOT_COMPLETE");
  }
  return available(base);
}

function deriveCustomerRefundAction(
  context: ReturnCaseActionContext,
  disposition: DispositionAnalysis,
  inventoryTreatment: InventoryTreatmentAnalysis,
): ReturnCaseAction {
  const base = {
    kind: "issue_customer_refund" as const,
    label: "Issue customer refund",
    description: "Refund the Card Shellz customer through the source Shopify order. This does not settle a dropship vendor account.",
  };
  if (context.businessContext !== "retail") {
    return notApplicable(base, "RETURN_CUSTOMER_REFUND_NOT_OWNED");
  }
  if (!context.policy) return blocked(base, "RETURN_POLICY_SNAPSHOT_INVALID");
  if (context.policy.customerRefundAuthority !== "card_shellz") {
    return notApplicable(base, "RETURN_CUSTOMER_REFUND_OWNED_EXTERNALLY");
  }
  if (context.lifecycle.customerRefundStatus === "completed") return completed(base);
  if (context.channelProvider !== "shopify") {
    return blocked(base, "RETURN_CUSTOMER_REFUND_PROVIDER_UNSUPPORTED");
  }
  if (context.lifecycle.caseStatus !== "open") return blocked(base, "RETURN_CASE_NOT_OPEN");
  if (context.lifecycle.approvalStatus !== "approved") return blocked(base, "RETURN_CASE_NOT_APPROVED");
  if (context.lifecycle.customerRefundStatus !== "pending"
    && context.lifecycle.customerRefundStatus !== "failed") {
    return blocked(base, "RETURN_CUSTOMER_REFUND_STATE_CONFLICT");
  }
  const inspectionBlocker = deriveCustomerRefundInspectionBlocker(context);
  if (inspectionBlocker) return blocked(base, inspectionBlocker);
  if (disposition.blocker) return blocked(base, disposition.blocker);
  if (inventoryTreatment.blocker) return blocked(base, inventoryTreatment.blocker);
  if (!disposition.summary.fullyRecorded) {
    return blocked(base, "RETURN_DISPOSITION_NOT_COMPLETE");
  }
  return available(base);
}

function deriveVendorSettlementAction(
  context: ReturnCaseActionContext,
  disposition: DispositionAnalysis,
  inventoryTreatment: InventoryTreatmentAnalysis,
): ReturnCaseAction {
  const base = {
    kind: "settle_vendor_account" as const,
    label: "Settle vendor account",
    description: "Post the approved return credit and applicable fees to the dropship vendor's Echelon wallet. This does not refund a marketplace buyer.",
  };
  if (context.businessContext !== "dropship") {
    return notApplicable(base, "RETURN_VENDOR_SETTLEMENT_NOT_APPLICABLE");
  }
  if (!context.policy) return blocked(base, "RETURN_POLICY_SNAPSHOT_INVALID");
  if (context.policy.vendorSettlementTrigger === "none") {
    return notApplicable(base, "RETURN_VENDOR_SETTLEMENT_NOT_APPLICABLE");
  }
  if (context.lifecycle.vendorSettlementStatus === "completed") return completed(base);
  if (context.vendorId === null) return blocked(base, "RETURN_VENDOR_ID_MISSING");
  if (context.lifecycle.caseStatus !== "open") return blocked(base, "RETURN_CASE_NOT_OPEN");
  if (context.lifecycle.approvalStatus !== "approved") return blocked(base, "RETURN_CASE_NOT_APPROVED");
  if (context.lifecycle.vendorSettlementStatus === "held") {
    return blocked(base, "RETURN_VENDOR_SETTLEMENT_HELD");
  }
  if (context.lifecycle.vendorSettlementStatus !== "pending"
    && context.lifecycle.vendorSettlementStatus !== "eligible"
    && context.lifecycle.vendorSettlementStatus !== "failed") {
    return blocked(base, "RETURN_VENDOR_SETTLEMENT_STATE_CONFLICT");
  }
  if (context.policy.vendorSettlementTrigger !== "inspection_approved") {
    return blocked(
      base,
      context.policy.vendorSettlementTrigger === "customer_refunded"
        ? "RETURN_VENDOR_TRIGGER_CUSTOMER_REFUND_UNPROVEN"
        : "RETURN_VENDOR_TRIGGER_CARRIER_CLAIM_UNPROVEN",
    );
  }
  if (!context.inspection || context.inspection.status !== "approved"
    || !isCoherentTerminalInspection(context, context.inspection)) {
    return blocked(base, "RETURN_INSPECTION_EVIDENCE_INVALID");
  }
  if (disposition.blocker) return blocked(base, disposition.blocker);
  if (inventoryTreatment.blocker) return blocked(base, inventoryTreatment.blocker);
  if (!disposition.summary.fullyRecorded) {
    return blocked(base, "RETURN_DISPOSITION_NOT_COMPLETE");
  }
  return available(base);
}

function deriveCustomerRefundInspectionBlocker(context: ReturnCaseActionContext): string | null {
  if (!context.policy) return "RETURN_POLICY_SNAPSHOT_INVALID";
  if (context.policy.inspectionRequirement === "none") {
    return context.lifecycle.inspectionStatus === "not_required" && context.inspection === null
      ? null
      : "RETURN_INSPECTION_STATE_CONFLICT";
  }
  if (!context.inspection) return "RETURN_INSPECTION_EVIDENCE_INVALID";
  if (context.inspection.status !== "approved") return "RETURN_INSPECTION_NOT_APPROVED";
  return isCoherentTerminalInspection(context, context.inspection)
    ? null
    : "RETURN_INSPECTION_EVIDENCE_INVALID";
}
function deriveDispositionInspectionBlocker(context: ReturnCaseActionContext): string | null {
  if (!context.policy) return "RETURN_POLICY_SNAPSHOT_INVALID";
  if (context.inspection && isCoherentTerminalInspection(context, context.inspection)) return null;
  if (context.policy.inspectionRequirement === "conditional"
    && context.conditionalInspectionDecision === null) {
    return "RETURN_CONDITIONAL_INSPECTION_UNRESOLVED";
  }
  if (context.policy.inspectionRequirement === "none"
    || context.conditionalInspectionDecision === "waived") {
    return context.inspection === null && context.lifecycle.inspectionStatus === "not_required"
      ? null
      : "RETURN_INSPECTION_STATE_CONFLICT";
  }
  if (context.policy.inspectionOwner !== "card_shellz") {
    return "RETURN_INSPECTION_OWNED_EXTERNALLY";
  }
  return "RETURN_INSPECTION_STATE_CONFLICT";
}

function deriveInspectionPolicyFailure(
  context: ReturnCaseActionContext,
): InspectionPrerequisiteFailure | null {
  if (!context.policy) return { state: "blocked", reasonCode: "RETURN_POLICY_SNAPSHOT_INVALID" };
  if (context.policy.inspectionRequirement === "none"
    || context.conditionalInspectionDecision === "waived") {
    return { state: "not_applicable", reasonCode: "RETURN_INSPECTION_NOT_REQUIRED" };
  }
  if (context.policy.inspectionOwner !== "card_shellz") {
    return { state: "not_applicable", reasonCode: "RETURN_INSPECTION_OWNED_EXTERNALLY" };
  }
  if (context.policy.inspectionRequirement === "conditional"
    && context.conditionalInspectionDecision === null) {
    return { state: "blocked", reasonCode: "RETURN_CONDITIONAL_INSPECTION_UNRESOLVED" };
  }
  return null;
}

function deriveInspectionOperationalFailure(
  context: ReturnCaseActionContext,
  receipt: ReceiptAnalysis,
): InspectionPrerequisiteFailure | null {
  if (context.lifecycle.caseStatus !== "open") {
    return { state: "blocked", reasonCode: "RETURN_CASE_NOT_OPEN" };
  }
  if (context.lifecycle.approvalStatus !== "approved") {
    return { state: "blocked", reasonCode: "RETURN_CASE_NOT_APPROVED" };
  }
  if (receipt.blocker) return { state: "blocked", reasonCode: receipt.blocker };
  if (!receipt.summary.fullyReceived || context.lifecycle.logisticsStatus !== "received") {
    return { state: "blocked", reasonCode: "RETURN_NOT_FULLY_RECEIVED" };
  }
  return null;
}
function applyInspectionPrerequisiteFailure(
  base: Omit<ReturnCaseAction, "state" | "reasonCode">,
  failure: InspectionPrerequisiteFailure,
): ReturnCaseAction {
  return failure.state === "not_applicable"
    ? notApplicable(base, failure.reasonCode)
    : blocked(base, failure.reasonCode);
}

function isCoherentInProgressInspection(
  context: ReturnCaseActionContext,
  inspection: ReturnInspectionFacts,
): boolean {
  return hasCoherentInspectionIdentity(inspection)
    && inspection.status === "in_progress"
    && context.lifecycle.inspectionStatus === "in_progress"
    && inspection.completedAt === null
    && inspection.completedBy === null;
}

function isCoherentTerminalInspection(
  context: ReturnCaseActionContext,
  inspection: ReturnInspectionFacts,
): boolean {
  return hasCoherentInspectionIdentity(inspection)
    && (inspection.status === "approved" || inspection.status === "rejected")
    && context.lifecycle.inspectionStatus === inspection.status
    && isValidDate(inspection.completedAt)
    && inspection.completedAt.getTime() >= inspection.startedAt.getTime()
    && typeof inspection.completedBy === "string"
    && inspection.completedBy.trim() !== "";
}

function hasCoherentInspectionIdentity(inspection: ReturnInspectionFacts): boolean {
  return isPositiveInteger(inspection.inspectionId)
    && isValidDate(inspection.startedAt)
    && typeof inspection.startedBy === "string"
    && inspection.startedBy.trim() !== "";
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function cloneInspectionSummary(inspection: ReturnInspectionFacts | null): ReturnInspectionFacts | null {
  if (!inspection) return null;
  return {
    ...inspection,
    startedAt: new Date(inspection.startedAt.getTime()),
    completedAt: inspection.completedAt ? new Date(inspection.completedAt.getTime()) : null,
  };
}

function analyzeDisposition(context: ReturnCaseActionContext): DispositionAnalysis {
  const empty: ReturnCaseDispositionSummary = {
    receivedUnits: 0,
    recordedUnits: 0,
    remainingUnits: 0,
    fullyRecorded: false,
    partiallyRecorded: false,
    items: [],
  };
  const receipt = context.receipt;
  if (!receipt) {
    return {
      summary: empty,
      blocker: context.disposition ? "RETURN_DISPOSITION_STATE_CONFLICT" : null,
    };
  }

  const itemById = new Map<number, ReturnCaseDispositionItemSummary>();
  let receivedUnits = 0;
  for (const receiptItem of receipt.items) {
    if (!isPositiveInteger(receiptItem.returnCaseItemId)
      || !isNonNegativeInteger(receiptItem.wmsReceivedQuantity)
      || itemById.has(Number(receiptItem.returnCaseItemId))) {
      return { summary: empty, blocker: "RETURN_DISPOSITION_STATE_CONFLICT" };
    }
    receivedUnits += receiptItem.wmsReceivedQuantity;
    if (!Number.isSafeInteger(receivedUnits)) {
      return { summary: empty, blocker: "RETURN_DISPOSITION_STATE_CONFLICT" };
    }
    itemById.set(Number(receiptItem.returnCaseItemId), {
      returnCaseItemId: Number(receiptItem.returnCaseItemId),
      receivedQuantity: receiptItem.wmsReceivedQuantity,
      restockSellableQuantity: 0,
      holdNonSellableQuantity: 0,
      recordedQuantity: 0,
      remainingQuantity: receiptItem.wmsReceivedQuantity,
    });
  }

  const evidence = context.disposition;
  if (!evidence) {
    return {
      summary: {
        ...empty,
        receivedUnits,
        remainingUnits: receivedUnits,
        items: Array.from(itemById.values()),
      },
      blocker: null,
    };
  }
  if (!isNonNegativeInteger(evidence.recordCount)
    || (evidence.recordCount === 0) !== (evidence.lines.length === 0)) {
    return { summary: empty, blocker: "RETURN_DISPOSITION_STATE_CONFLICT" };
  }

  const dispositionIds = new Set<number>();
  const dispositionItemIds = new Set<number>();
  const lineKeys = new Set<string>();
  for (const line of evidence.lines) {
    if (!isPositiveInteger(line.dispositionItemId)
      || !isPositiveInteger(line.dispositionId)
      || !isPositiveInteger(line.returnCaseItemId)
      || !isPositiveInteger(line.quantity)
      || !isDispositionTreatment(line.treatment)) {
      return { summary: empty, blocker: "RETURN_DISPOSITION_STATE_CONFLICT" };
    }
    const item = itemById.get(line.returnCaseItemId);
    const lineKey = `${line.dispositionId}:${line.returnCaseItemId}`;
    if (!item || lineKeys.has(lineKey) || dispositionItemIds.has(line.dispositionItemId)) {
      return { summary: empty, blocker: "RETURN_DISPOSITION_STATE_CONFLICT" };
    }
    dispositionItemIds.add(line.dispositionItemId);
    lineKeys.add(lineKey);
    dispositionIds.add(line.dispositionId);
    if (line.treatment === "restock_sellable") {
      item.restockSellableQuantity += line.quantity;
    } else {
      item.holdNonSellableQuantity += line.quantity;
    }
    item.recordedQuantity += line.quantity;
    if (!Number.isSafeInteger(item.recordedQuantity)
      || !Number.isSafeInteger(item.restockSellableQuantity)
      || !Number.isSafeInteger(item.holdNonSellableQuantity)
      || item.recordedQuantity > item.receivedQuantity) {
      return { summary: empty, blocker: "RETURN_DISPOSITION_STATE_CONFLICT" };
    }
    item.remainingQuantity = item.receivedQuantity - item.recordedQuantity;
  }
  if (dispositionIds.size !== evidence.recordCount) {
    return { summary: empty, blocker: "RETURN_DISPOSITION_STATE_CONFLICT" };
  }

  let recordedUnits = 0;
  for (const item of itemById.values()) {
    recordedUnits += item.recordedQuantity;
    if (!Number.isSafeInteger(recordedUnits)) {
      return { summary: empty, blocker: "RETURN_DISPOSITION_STATE_CONFLICT" };
    }
  }
  const remainingUnits = receivedUnits - recordedUnits;
  return {
    summary: {
      receivedUnits,
      recordedUnits,
      remainingUnits,
      fullyRecorded: receivedUnits > 0 && remainingUnits === 0,
      partiallyRecorded: recordedUnits > 0 && remainingUnits > 0,
      items: Array.from(itemById.values()),
    },
    blocker: null,
  };
}

function analyzeInventoryTreatment(
  context: ReturnCaseActionContext,
  disposition: DispositionAnalysis,
): InventoryTreatmentAnalysis {
  const empty: ReturnCaseInventoryTreatmentSummary = {
    dispositionUnits: 0,
    appliedUnits: 0,
    remainingUnits: 0,
    fullyApplied: false,
    partiallyApplied: false,
    items: [],
  };
  if (disposition.blocker || !context.disposition) {
    return {
      summary: empty,
      blocker: context.inventoryTreatment ? "RETURN_INVENTORY_TREATMENT_STATE_CONFLICT" : null,
    };
  }

  const sourceById = new Map<number, ReturnCaseInventoryTreatmentItemSummary>();
  let dispositionUnits = 0;
  for (const line of context.disposition.lines) {
    if (sourceById.has(line.dispositionItemId)) {
      return { summary: empty, blocker: "RETURN_INVENTORY_TREATMENT_STATE_CONFLICT" };
    }
    dispositionUnits = checkedAdd(dispositionUnits, line.quantity);
    sourceById.set(line.dispositionItemId, {
      dispositionItemId: line.dispositionItemId,
      returnCaseItemId: line.returnCaseItemId,
      treatment: line.treatment,
      quantity: line.quantity,
      warehouseLocationId: null,
      inventoryTransactionId: null,
      inventoryLotId: null,
      applied: false,
    });
  }

  const evidence = context.inventoryTreatment;
  if (!evidence) {
    return {
      summary: { ...empty, dispositionUnits, remainingUnits: dispositionUnits, items: Array.from(sourceById.values()) },
      blocker: null,
    };
  }
  if (!isNonNegativeInteger(evidence.recordCount)
    || (evidence.recordCount === 0) !== (evidence.lines.length === 0)) {
    return { summary: empty, blocker: "RETURN_INVENTORY_TREATMENT_STATE_CONFLICT" };
  }

  const appliedSourceIds = new Set<number>();
  for (const line of evidence.lines) {
    const source = sourceById.get(line.dispositionItemId);
    if (!source
      || appliedSourceIds.has(line.dispositionItemId)
      || line.returnCaseItemId !== source.returnCaseItemId
      || line.treatment !== source.treatment
      || line.quantity !== source.quantity) {
      return { summary: empty, blocker: "RETURN_INVENTORY_TREATMENT_STATE_CONFLICT" };
    }
    const sellableEvidenceValid = line.treatment === "restock_sellable"
      && isPositiveInteger(line.warehouseLocationId)
      && isPositiveInteger(line.inventoryTransactionId)
      && isPositiveInteger(line.inventoryLotId);
    const holdEvidenceValid = line.treatment === "hold_non_sellable"
      && line.warehouseLocationId === null
      && line.inventoryTransactionId === null
      && line.inventoryLotId === null;
    if (!sellableEvidenceValid && !holdEvidenceValid) {
      return { summary: empty, blocker: "RETURN_INVENTORY_TREATMENT_STATE_CONFLICT" };
    }
    appliedSourceIds.add(line.dispositionItemId);
    Object.assign(source, { ...line, applied: true });
  }
  if (evidence.recordCount > evidence.lines.length) {
    return { summary: empty, blocker: "RETURN_INVENTORY_TREATMENT_STATE_CONFLICT" };
  }

  let appliedUnits = 0;
  for (const item of sourceById.values()) {
    if (item.applied) appliedUnits = checkedAdd(appliedUnits, item.quantity);
  }
  const remainingUnits = dispositionUnits - appliedUnits;
  return {
    summary: {
      dispositionUnits,
      appliedUnits,
      remainingUnits,
      fullyApplied: dispositionUnits > 0 && remainingUnits === 0,
      partiallyApplied: appliedUnits > 0 && remainingUnits > 0,
      items: Array.from(sourceById.values()),
    },
    blocker: null,
  };
}

function isDispositionTreatment(value: unknown): value is ReturnDispositionTreatment {
  return typeof value === "string"
    && returnDispositionTreatments.includes(value as ReturnDispositionTreatment);
}

function analyzeReceipt(context: ReturnCaseActionContext): ReceiptAnalysis {
  const empty = {
    expectedUnits: 0,
    receivedUnits: 0,
    remainingUnits: 0,
    fullyReceived: false,
    partiallyReceived: false,

  };
  const receipt = context.receipt;
  if (!receipt) return { summary: empty, blocker: "RETURN_WMS_RETURN_MISSING" };
  if (!isPositiveInteger(receipt.wmsReturnId)
    || !isNonNegativeInteger(receipt.canonicalItemCount)
    || receipt.canonicalItemCount === 0
    || receipt.items.length === 0) {
    return { summary: empty, blocker: "RETURN_WMS_ITEM_SET_MISMATCH" };
  }

  const canonicalIds = new Set<number>();
  const wmsIds = new Set<number>();
  let membershipMismatch = receipt.items.length !== receipt.canonicalItemCount;
  let expectedUnits = 0;
  let receivedUnits = 0;
  for (const item of receipt.items) {
    if (!isPositiveInteger(item.wmsReturnItemId)
      || wmsIds.has(item.wmsReturnItemId)) {
      membershipMismatch = true;
      continue;
    }
    wmsIds.add(item.wmsReturnItemId);
    if (item.returnCaseItemId === null || item.caseExpectedQuantity === null) {
      membershipMismatch = true;
      continue;
    }
    if (!isPositiveInteger(item.returnCaseItemId)
      || !isPositiveInteger(item.caseExpectedQuantity)
      || !isPositiveInteger(item.wmsExpectedQuantity)
      || !isNonNegativeInteger(item.wmsReceivedQuantity)
      || item.caseExpectedQuantity !== item.wmsExpectedQuantity
      || item.wmsReceivedQuantity > item.wmsExpectedQuantity
      || canonicalIds.has(item.returnCaseItemId)) {
      return { summary: empty, blocker: "RETURN_WMS_ITEM_SET_MISMATCH" };
    }
    const expectedItemStatus = item.wmsReceivedQuantity === 0
      ? "expected"
      : item.wmsReceivedQuantity === item.wmsExpectedQuantity
        ? "received"
        : "partially_received";
    if (item.wmsStatus !== expectedItemStatus) {
      return { summary: empty, blocker: "RETURN_RECEIPT_STATE_CONFLICT" };
    }
    canonicalIds.add(item.returnCaseItemId);
    expectedUnits = checkedAdd(expectedUnits, item.wmsExpectedQuantity);
    receivedUnits = checkedAdd(receivedUnits, item.wmsReceivedQuantity);
  }

  const remainingUnits = expectedUnits - receivedUnits;
  const fullyReceived = expectedUnits > 0 && remainingUnits === 0;
  const partiallyReceived = receivedUnits > 0 && remainingUnits > 0;
  const summary = { expectedUnits, receivedUnits, remainingUnits, fullyReceived, partiallyReceived };
  if (membershipMismatch || canonicalIds.size !== receipt.canonicalItemCount) {
    return { summary, blocker: "RETURN_WMS_ITEM_SET_MISMATCH" };
  }

  const expectedWmsStatus = fullyReceived ? "received" : partiallyReceived ? "partially_received" : "expected";
  if (receipt.wmsStatus !== expectedWmsStatus
    || (receivedUnits > 0 && receipt.receivedAt === null)
    || receipt.restocked
    || (fullyReceived && context.lifecycle.logisticsStatus !== "received")
    || (partiallyReceived && context.lifecycle.logisticsStatus !== "partially_received")
    || (!fullyReceived && !partiallyReceived
      && !ZERO_RECEIPT_LOGISTICS_STATUSES.has(context.lifecycle.logisticsStatus))) {
    return { summary, blocker: "RETURN_RECEIPT_STATE_CONFLICT" };
  }
  return { summary, blocker: null };
}

function available(base: Omit<ReturnCaseAction, "state" | "reasonCode">): ReturnCaseAction {
  return { ...base, state: "available", reasonCode: null };
}

function completed(base: Omit<ReturnCaseAction, "state" | "reasonCode">): ReturnCaseAction {
  return { ...base, state: "completed", reasonCode: null };
}

function blocked(
  base: Omit<ReturnCaseAction, "state" | "reasonCode">,
  reasonCode: string,
): ReturnCaseAction {
  return { ...base, state: "blocked", reasonCode };
}

function notApplicable(
  base: Omit<ReturnCaseAction, "state" | "reasonCode">,
  reasonCode: string,
): ReturnCaseAction {
  return { ...base, state: "not_applicable", reasonCode };
}

function checkedAdd(total: number, value: number): number {
  const result = total + value;
  if (!Number.isSafeInteger(result)) {
    throw new ReturnCaseActionDomainError(
      "RETURN_RECEIPT_QUANTITY_INVALID",
      "Return receipt totals exceed the supported range.",
    );
  }
  return result;
}

function readEnum<const TValues extends readonly string[]>(
  value: unknown,
  values: TValues,
  field: string,
): TValues[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw invalidPolicy(`Policy snapshot ${field} is invalid.`, { field, value });
  }
  return value as TValues[number];
}

function readPositiveInteger(value: unknown, field: string): number {
  if (!isPositiveInteger(value)) throw invalidPolicy(`Policy snapshot ${field} is invalid.`, { field, value });
  return Number(value);
}

function readNonNegativeInteger(value: unknown, field: string): number {
  if (!isNonNegativeInteger(value)) throw invalidPolicy(`Policy snapshot ${field} is invalid.`, { field, value });
  return Number(value);
}

function readRequiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidPolicy(`Policy snapshot ${field} is invalid.`, { field, value });
  }
  return value;
}

function readBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw invalidPolicy(`Policy snapshot ${field} is invalid.`, { field, value });
  }
  return value;
}

function invalidPolicy(
  message: string,
  context?: Record<string, unknown>,
): ReturnCaseActionDomainError {
  return new ReturnCaseActionDomainError("RETURN_POLICY_SNAPSHOT_INVALID", message, context);
}

function isPositiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
