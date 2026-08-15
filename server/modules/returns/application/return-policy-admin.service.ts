import { createHash } from "crypto";
import type { ReturnPolicy, ReturnPolicyScopeKind, ReturnBusinessContext } from "@shared/schema";
import {
  normalizeReturnPolicyScope,
  resolveReturnPolicy,
  ReturnPolicyDomainError,
  type ReturnPolicyResolutionInput,
  type ReturnPolicyScopeInput,
} from "../domain/return-policy";

export const returnPolicyAppliesToKinds = ["all_orders", "channel", "vendor", "store"] as const;
export type ReturnPolicyAppliesTo = (typeof returnPolicyAppliesToKinds)[number];

export interface PublicReturnPolicyScopeInput {
  appliesTo: ReturnPolicyAppliesTo;
  channelId: number | null;
  vendorId: number | null;
  storeConnectionId: number | null;
}

export interface PublicReturnPolicyResolutionInput {
  channelId: number;
  vendorId: number | null;
  storeConnectionId: number | null;
}

export interface ReturnPolicyDecisionInput {
  name: string;
  returnWindowDays: number;
  returnDestination: "card_shellz" | "vendor" | "marketplace";
  approvalAuthority: "card_shellz" | "marketplace" | "vendor";
  labelProvider: "shipstation" | "marketplace" | "vendor" | "none";
  returnShippingPayer: "card_shellz" | "vendor" | "customer" | "marketplace" | "carrier";
  inspectionRequirement: "required" | "conditional" | "none";
  inspectionOwner: "card_shellz" | "vendor" | "marketplace";
  customerRefundAuthority: "card_shellz" | "marketplace" | "vendor";
  vendorSettlementTrigger: "inspection_approved" | "customer_refunded" | "carrier_claim_paid" | "none";
  returnlessRefundAllowed: boolean;
  notes: string | null;
}

export interface CreateReturnPolicyInput extends PublicReturnPolicyScopeInput, ReturnPolicyDecisionInput {
  idempotencyKey: string;
  actor: string;
}

export interface ReturnPolicyChannelReference {
  id: number;
  name: string;
  type: string;
  provider: string;
  status: string;
}

export interface ReturnPolicyVendorReference {
  id: number;
  memberId: string;
  businessName: string | null;
  email: string | null;
  status: string;
}

export interface ReturnPolicyStoreReference {
  id: number;
  vendorId: number;
  platform: string;
  displayName: string | null;
  shopDomain: string | null;
  status: string;
}

export interface ScopeReferences {
  channel: ReturnPolicyChannelReference | null;
  vendor: ReturnPolicyVendorReference | null;
  store: ReturnPolicyStoreReference | null;
  dropshipOmsChannel: ReturnPolicyChannelReference;
}

export interface ReturnPolicyOverview {
  policies: ReturnPolicy[];
  channels: ReturnPolicyChannelReference[];
  referencedVendors: ReturnPolicyVendorReference[];
  referencedStores: ReturnPolicyStoreReference[];
  dropshipOmsChannelId: number;
}

export interface ReturnPolicyCommandRecord {
  requestHash: string;
  response: ReturnPolicy;
}

export interface ReturnPolicyAdminTransaction {
  lockCommand(idempotencyKey: string): Promise<void>;
  findCommand(idempotencyKey: string): Promise<ReturnPolicyCommandRecord | null>;
  getScopeReferences(scope: PublicReturnPolicyScopeInput): Promise<ScopeReferences>;
  getActivePolicyForUpdate(scopeKey: string): Promise<ReturnPolicy | null>;
  getNextVersion(scopeKey: string): Promise<number>;
  retirePolicy(policy: ReturnPolicy, actor: string, now: Date): Promise<void>;
  insertPolicy(input: Omit<ReturnPolicy, "id" | "createdAt">): Promise<ReturnPolicy>;
  recordCommand(input: { idempotencyKey: string; requestHash: string; response: ReturnPolicy; actor: string; createdAt: Date }): Promise<void>;
  writeAudit(input: { actor: string; before: ReturnPolicy | null; after: ReturnPolicy; now: Date }): Promise<void>;
}

export interface ReturnPolicyAdminStore {
  listOverview(): Promise<ReturnPolicyOverview>;
  listActivePolicies(): Promise<ReturnPolicy[]>;
  getDropshipOmsChannel(): Promise<ReturnPolicyChannelReference>;
  searchVendors(search: string, limit: number): Promise<ReturnPolicyVendorReference[]>;
  searchStores(vendorId: number, search: string, limit: number): Promise<ReturnPolicyStoreReference[]>;
  transaction<T>(work: (tx: ReturnPolicyAdminTransaction) => Promise<T>): Promise<T>;
}

export class ReturnPolicyAdminError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ReturnPolicyAdminError";
  }
}

export class ReturnPolicyAdminService {
  constructor(
    private readonly store: ReturnPolicyAdminStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async listOverview(): Promise<ReturnPolicyOverview> {
    const overview = await this.store.listOverview();
    return {
      ...overview,
      policies: overview.policies.filter((policy) => policy.status === "active"),
    };
  }

  searchVendors(search: string, limit: number): Promise<ReturnPolicyVendorReference[]> {
    return this.store.searchVendors(search.trim(), validateSearchLimit(limit));
  }

  searchStores(vendorId: number, search: string, limit: number): Promise<ReturnPolicyStoreReference[]> {
    if (!Number.isInteger(vendorId) || vendorId <= 0) {
      throw new ReturnPolicyAdminError("RETURN_POLICY_INVALID", "vendorId must be a positive integer.", 400);
    }
    return this.store.searchStores(vendorId, search.trim(), validateSearchLimit(limit));
  }

  async resolve(input: PublicReturnPolicyResolutionInput) {
    validateResolutionInput(input);
    const dropshipOmsChannel = await this.store.getDropshipOmsChannel();
    const internalInput: ReturnPolicyResolutionInput = {
      businessContext: input.channelId === dropshipOmsChannel.id ? "dropship" : "retail",
      channelId: input.channelId,
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
    };
    const candidates = (await this.store.listActivePolicies()).map(asCandidate);
    try {
      const resolution = resolveReturnPolicy(candidates, internalInput);
      if (!resolution) {
        throw new ReturnPolicyAdminError("RETURN_POLICY_NOT_CONFIGURED", "No active return policy matches this return.", 404, { ...input });
      }
      return resolution;
    } catch (error) {
      throw translateDomainError(error);
    }
  }

  async createVersion(input: CreateReturnPolicyInput): Promise<{ policy: ReturnPolicy; replayed: boolean }> {
    validateCreateInput(input);
    const normalizedInput = {
      ...input,
      name: input.name.trim(),
      notes: input.notes?.trim() || null,
      actor: input.actor.trim(),
      idempotencyKey: input.idempotencyKey.trim(),
    };
    const requestHash = hashRequest(normalizedInput);
    const now = this.clock();

    return this.store.transaction(async (tx) => {
      await tx.lockCommand(normalizedInput.idempotencyKey);
      const priorCommand = await tx.findCommand(normalizedInput.idempotencyKey);
      if (priorCommand) {
        if (priorCommand.requestHash !== requestHash) {
          throw new ReturnPolicyAdminError("RETURN_POLICY_IDEMPOTENCY_CONFLICT", "This idempotency key was already used for a different policy command.", 409);
        }
        return { policy: priorCommand.response, replayed: true };
      }

      const references = await tx.getScopeReferences(normalizedInput);
      validateReferences(normalizedInput, references);
      const normalized = normalizePublicScope(normalizedInput, references.dropshipOmsChannel.id);
      const active = await tx.getActivePolicyForUpdate(normalized.scopeKey);
      const version = await tx.getNextVersion(normalized.scopeKey);
      if (active) await tx.retirePolicy(active, normalizedInput.actor, now);

      const policy = await tx.insertPolicy({
        name: normalizedInput.name,
        scopeKind: normalized.scopeKind,
        scopeKey: normalized.scopeKey,
        businessContext: normalized.businessContext,
        channelId: normalized.channelId,
        vendorId: normalized.vendorId,
        storeConnectionId: normalized.storeConnectionId,
        version,
        status: "active",
        returnWindowDays: normalizedInput.returnWindowDays,
        returnDestination: normalizedInput.returnDestination,
        approvalAuthority: normalizedInput.approvalAuthority,
        labelProvider: normalizedInput.labelProvider,
        returnShippingPayer: normalizedInput.returnShippingPayer,
        inspectionRequirement: normalizedInput.inspectionRequirement,
        inspectionOwner: normalizedInput.inspectionOwner,
        customerRefundAuthority: normalizedInput.customerRefundAuthority,
        vendorSettlementTrigger: normalizedInput.vendorSettlementTrigger,
        returnlessRefundAllowed: normalizedInput.returnlessRefundAllowed,
        notes: normalizedInput.notes,
        supersedesPolicyId: active?.id ?? null,
        createdBy: normalizedInput.actor,
        retiredBy: null,
        retiredAt: null,
      });
      await tx.recordCommand({ idempotencyKey: normalizedInput.idempotencyKey, requestHash, response: policy, actor: normalizedInput.actor, createdAt: now });
      await tx.writeAudit({ actor: normalizedInput.actor, before: active, after: policy, now });
      return { policy, replayed: false };
    });
  }
}

function validateCreateInput(input: CreateReturnPolicyInput): void {
  if (!input.name.trim()) throw new ReturnPolicyAdminError("RETURN_POLICY_INVALID", "Policy name is required.", 400);
  if (!input.actor.trim()) throw new ReturnPolicyAdminError("RETURN_POLICY_INVALID", "Audit actor is required.", 400);
  if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 160) throw new ReturnPolicyAdminError("RETURN_POLICY_INVALID", "A valid idempotency key is required.", 400);
  if (!Number.isInteger(input.returnWindowDays) || input.returnWindowDays < 0 || input.returnWindowDays > 3650) throw new ReturnPolicyAdminError("RETURN_POLICY_INVALID", "Return window must be between 0 and 3650 days.", 400);
  validatePublicScope(input);
}

function validatePublicScope(scope: PublicReturnPolicyScopeInput): void {
  const selectedIds = [scope.channelId, scope.vendorId, scope.storeConnectionId];
  for (const id of selectedIds) {
    if (id !== null && (!Number.isInteger(id) || id <= 0)) {
      throw new ReturnPolicyAdminError("RETURN_POLICY_INVALID", "Scope identifiers must be positive integers.", 400);
    }
  }
  const valid =
    (scope.appliesTo === "all_orders" && selectedIds.every((id) => id === null)) ||
    (scope.appliesTo === "channel" && scope.channelId !== null && scope.vendorId === null && scope.storeConnectionId === null) ||
    (scope.appliesTo === "vendor" && scope.channelId === null && scope.vendorId !== null && scope.storeConnectionId === null) ||
    (scope.appliesTo === "store" && scope.channelId === null && scope.vendorId !== null && scope.storeConnectionId !== null);
  if (!valid) throw new ReturnPolicyAdminError("RETURN_POLICY_INVALID", "The selected policy scope is incomplete or contains conflicting identifiers.", 400);
}

function validateResolutionInput(input: PublicReturnPolicyResolutionInput): void {
  if (!Number.isInteger(input.channelId) || input.channelId <= 0) throw new ReturnPolicyAdminError("RETURN_POLICY_INVALID", "channelId must be a positive integer.", 400);
  if (input.vendorId !== null && (!Number.isInteger(input.vendorId) || input.vendorId <= 0)) throw new ReturnPolicyAdminError("RETURN_POLICY_INVALID", "vendorId must be a positive integer.", 400);
  if (input.storeConnectionId !== null && (!Number.isInteger(input.storeConnectionId) || input.storeConnectionId <= 0)) throw new ReturnPolicyAdminError("RETURN_POLICY_INVALID", "storeConnectionId must be a positive integer.", 400);
  if (input.storeConnectionId !== null && input.vendorId === null) throw new ReturnPolicyAdminError("RETURN_POLICY_INVALID", "A store resolution requires vendorId.", 400);
}

function validateReferences(scope: PublicReturnPolicyScopeInput, refs: ScopeReferences): void {
  if (scope.channelId !== null && !refs.channel) throw new ReturnPolicyAdminError("RETURN_POLICY_CHANNEL_NOT_FOUND", "The selected channel does not exist.", 400, { channelId: scope.channelId });
  if (scope.vendorId !== null && !refs.vendor) throw new ReturnPolicyAdminError("RETURN_POLICY_VENDOR_NOT_FOUND", "The selected vendor does not exist.", 400, { vendorId: scope.vendorId });
  if (scope.storeConnectionId !== null && !refs.store) throw new ReturnPolicyAdminError("RETURN_POLICY_STORE_NOT_FOUND", "The selected store connection does not exist.", 400, { storeConnectionId: scope.storeConnectionId });
  if (refs.store && refs.store.vendorId !== scope.vendorId) throw new ReturnPolicyAdminError("RETURN_POLICY_SCOPE_MISMATCH", "The selected store does not belong to the selected vendor.", 400);
}

function normalizePublicScope(scope: PublicReturnPolicyScopeInput, dropshipOmsChannelId: number) {
  let internal: ReturnPolicyScopeInput;
  switch (scope.appliesTo) {
    case "all_orders":
      internal = { scopeKind: "global", businessContext: null, channelId: null, vendorId: null, storeConnectionId: null };
      break;
    case "channel":
      internal = {
        scopeKind: "channel_context",
        businessContext: scope.channelId === dropshipOmsChannelId ? "dropship" : "retail",
        channelId: scope.channelId,
        vendorId: null,
        storeConnectionId: null,
      };
      break;
    case "vendor":
      internal = { scopeKind: "vendor_context", businessContext: "dropship", channelId: null, vendorId: scope.vendorId, storeConnectionId: null };
      break;
    case "store":
      internal = {
        scopeKind: "store",
        businessContext: "dropship",
        channelId: dropshipOmsChannelId,
        vendorId: scope.vendorId,
        storeConnectionId: scope.storeConnectionId,
      };
      break;
  }
  try {
    return normalizeReturnPolicyScope(internal);
  } catch (error) {
    throw translateDomainError(error);
  }
}

function validateSearchLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new ReturnPolicyAdminError("RETURN_POLICY_INVALID", "Search limit must be between 1 and 50.", 400);
  }
  return limit;
}

function asCandidate(policy: ReturnPolicy) {
  return { ...policy, scopeKind: policy.scopeKind as ReturnPolicyScopeKind, businessContext: policy.businessContext as ReturnBusinessContext | null };
}

function hashRequest(input: object): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function translateDomainError(error: unknown): Error {
  if (error instanceof ReturnPolicyDomainError) {
    return new ReturnPolicyAdminError(error.code, error.message, error.code === "RETURN_POLICY_AMBIGUOUS" ? 409 : 400, error.context);
  }
  return error instanceof Error ? error : new Error(String(error));
}
