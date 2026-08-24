import type {
  ReturnApprovalStatus,
  ReturnBusinessContext,
  ReturnCaseStatus,
  ReturnCustomerRefundStatus,
  ReturnInspectionStatus,
  ReturnLogisticsStatus,
  ReturnPolicy,
  ReturnVendorSettlementStatus,
} from "@shared/schema";

export interface ReturnCaseLifecycle {
  caseStatus: ReturnCaseStatus;
  approvalStatus: ReturnApprovalStatus;
  logisticsStatus: ReturnLogisticsStatus;
  inspectionStatus: ReturnInspectionStatus;
  customerRefundStatus: ReturnCustomerRefundStatus;
  vendorSettlementStatus: ReturnVendorSettlementStatus;
}

export interface ReturnPolicySnapshot {
  id: number;
  name: string;
  version: number;
  scopeKind: string;
  scopeKey: string;
  returnWindowDays: number;
  returnDestination: string;
  approvalAuthority: string;
  labelProvider: string;
  returnShippingPayer: string;
  inspectionRequirement: string;
  inspectionOwner: string;
  customerRefundAuthority: string;
  vendorSettlementTrigger: string;
  returnlessRefundAllowed: boolean;
}

export class ReturnCaseDomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ReturnCaseDomainError";
  }
}

export function deriveShopifyRefundReturnLifecycle(policy: ReturnPolicy): ReturnCaseLifecycle {
  validatePolicyIdentity(policy);
  return {
    caseStatus: "open",
    approvalStatus: "approved",
    logisticsStatus: "awaiting_return",
    inspectionStatus: policy.inspectionRequirement === "none" ? "not_required" : "pending",
    customerRefundStatus: "completed",
    vendorSettlementStatus: "not_applicable",
  };
}

export function deriveManualReturnLifecycle(
  policy: ReturnPolicy,
  businessContext: ReturnBusinessContext,
): ReturnCaseLifecycle {
  validatePolicyIdentity(policy);
  return {
    caseStatus: "open",
    approvalStatus: "approved",
    logisticsStatus: "awaiting_return",
    inspectionStatus: policy.inspectionRequirement === "none" ? "not_required" : "pending",
    customerRefundStatus: businessContext === "retail" ? "pending" : "not_required",
    vendorSettlementStatus:
      businessContext === "dropship" && policy.vendorSettlementTrigger !== "none"
        ? "pending"
        : "not_applicable",
  };
}

export function snapshotReturnPolicy(policy: ReturnPolicy): ReturnPolicySnapshot {
  return {
    id: policy.id,
    name: policy.name,
    version: policy.version,
    scopeKind: policy.scopeKind,
    scopeKey: policy.scopeKey,
    returnWindowDays: policy.returnWindowDays,
    returnDestination: policy.returnDestination,
    approvalAuthority: policy.approvalAuthority,
    labelProvider: policy.labelProvider,
    returnShippingPayer: policy.returnShippingPayer,
    inspectionRequirement: policy.inspectionRequirement,
    inspectionOwner: policy.inspectionOwner,
    customerRefundAuthority: policy.customerRefundAuthority,
    vendorSettlementTrigger: policy.vendorSettlementTrigger,
    returnlessRefundAllowed: policy.returnlessRefundAllowed,
  };
}

function validatePolicyIdentity(policy: ReturnPolicy): void {
  if (!Number.isInteger(policy.id) || policy.id <= 0 || !Number.isInteger(policy.version) || policy.version <= 0) {
    throw new ReturnCaseDomainError("RETURN_CASE_POLICY_INVALID", "Resolved return policy identity is invalid.", {
      policyId: policy.id,
      policyVersion: policy.version,
    });
  }
}
