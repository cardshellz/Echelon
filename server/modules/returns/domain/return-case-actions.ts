import {
  returnApprovalAuthorities,
  returnDestinations,
  returnInspectionOwners,
  returnInspectionRequirements,
  returnLabelProviders,
  returnPolicyScopeKinds,
  returnRefundAuthorities,
  returnShippingPayers,
  returnVendorSettlementTriggers,
  type ReturnInspectionOwner,
  type ReturnInspectionRequirement,
  type ReturnDestination,
} from "@shared/schema";
import type { ReturnCaseLifecycle, ReturnPolicySnapshot } from "./return-case";

const ZERO_RECEIPT_LOGISTICS_STATUSES = new Set([
  "awaiting_return",
  "label_ready",
  "in_transit",
  "delivered",
]);

export const returnCaseActionKinds = ["record_receipt", "start_inspection", "complete_inspection"] as const;
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

export interface ReturnCaseReceiptSummary {
  expectedUnits: number;
  receivedUnits: number;
  remainingUnits: number;
  fullyReceived: boolean;
  partiallyReceived: boolean;
}

export interface ReturnCaseActionContext {
  lifecycle: ReturnCaseLifecycle;
  policy: ReturnPolicySnapshotFacts | null;
  receipt: ReturnReceiptFacts | null;
  inspection: ReturnInspectionFacts | null;
  conditionalInspectionDecision: "required" | "waived" | null;
}

export interface ReturnCaseActionPlan {
  nextAction: ReturnCaseActionKind | null;
  receiptSummary: ReturnCaseReceiptSummary;
  inspectionSummary: ReturnInspectionFacts | null;
  actions: ReturnCaseAction[];
}

interface ReceiptAnalysis {
  summary: ReturnCaseReceiptSummary;
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
  const actions = [
    deriveReceiptAction(context, receipt),
    deriveInspectionAction(context, receipt),
    deriveCompleteInspectionAction(context, receipt),
  ];
  return {
    nextAction: actions.find((action) => action.state === "available")?.kind ?? null,
    receiptSummary: receipt.summary,
    inspectionSummary: cloneInspectionSummary(context.inspection),
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
    description: "Record physical receipt against the expected WMS return. Inventory remains unavailable until inspection determines its disposition.",
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
