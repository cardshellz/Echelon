import { createHash } from "crypto";
import type { ReturnPolicy, ReturnPolicyScopeKind, ReturnBusinessContext } from "@shared/schema";
import {
  normalizeReturnPolicyScope,
  resolveReturnPolicy,
  ReturnPolicyDomainError,
  type ReturnPolicyResolutionInput,
  type ReturnPolicyScopeInput,
} from "../domain/return-policy";

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

export interface CreateReturnPolicyInput extends ReturnPolicyScopeInput, ReturnPolicyDecisionInput {
  idempotencyKey: string;
  actor: string;
}

export interface ScopeReferences {
  channel: { id: number; name: string; provider: string } | null;
  vendor: { id: number; memberId: string } | null;
  store: { id: number; vendorId: number; platform: string } | null;
}

export interface ReturnPolicyOverview {
  policies: ReturnPolicy[];
  channels: Array<{ id: number; name: string; provider: string; status: string }>;
  vendors: Array<{ id: number; memberId: string; businessName: string | null }>;
  stores: Array<{ id: number; vendorId: number; platform: string; displayName: string | null }>;
}

export interface ReturnPolicyCommandRecord {
  requestHash: string;
  response: ReturnPolicy;
}

export interface ReturnPolicyAdminTransaction {
  lockCommand(idempotencyKey: string): Promise<void>;
  findCommand(idempotencyKey: string): Promise<ReturnPolicyCommandRecord | null>;
  getScopeReferences(scope: ReturnPolicyScopeInput): Promise<ScopeReferences>;
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

  listOverview(): Promise<ReturnPolicyOverview> {
    return this.store.listOverview();
  }

  async resolve(input: ReturnPolicyResolutionInput) {
    validateResolutionInput(input);
    const candidates = (await this.store.listActivePolicies()).map(asCandidate);
    try {
      const resolution = resolveReturnPolicy(candidates, input);
      if (!resolution) {
        throw new ReturnPolicyAdminError("RETURN_POLICY_NOT_CONFIGURED", "No active return policy matches this return.", 404, { ...input });
      }
      return resolution;
    } catch (error) {
      throw translateDomainError(error);
    }
  }

  async createVersion(input: CreateReturnPolicyInput): Promise<{ policy: ReturnPolicy; replayed: boolean }> {
    const normalized = validateCreateInput(input);
    const requestHash = hashRequest(normalized);
    const now = this.clock();

    return this.store.transaction(async (tx) => {
      await tx.lockCommand(normalized.idempotencyKey);
      const priorCommand = await tx.findCommand(normalized.idempotencyKey);
      if (priorCommand) {
        if (priorCommand.requestHash !== requestHash) {
          throw new ReturnPolicyAdminError("RETURN_POLICY_IDEMPOTENCY_CONFLICT", "This idempotency key was already used for a different policy command.", 409);
        }
        return { policy: priorCommand.response, replayed: true };
      }

      const references = await tx.getScopeReferences(normalized);
      validateReferences(normalized, references);
      const active = await tx.getActivePolicyForUpdate(normalized.scopeKey);
      const version = await tx.getNextVersion(normalized.scopeKey);
      if (active) await tx.retirePolicy(active, normalized.actor, now);

      const policy = await tx.insertPolicy({
        name: normalized.name,
        scopeKind: normalized.scopeKind,
        scopeKey: normalized.scopeKey,
        businessContext: normalized.businessContext,
        channelId: normalized.channelId,
        vendorId: normalized.vendorId,
        storeConnectionId: normalized.storeConnectionId,
        version,
        status: "active",
        returnWindowDays: normalized.returnWindowDays,
        returnDestination: normalized.returnDestination,
        approvalAuthority: normalized.approvalAuthority,
        labelProvider: normalized.labelProvider,
        returnShippingPayer: normalized.returnShippingPayer,
        inspectionRequirement: normalized.inspectionRequirement,
        inspectionOwner: normalized.inspectionOwner,
        customerRefundAuthority: normalized.customerRefundAuthority,
        vendorSettlementTrigger: normalized.vendorSettlementTrigger,
        returnlessRefundAllowed: normalized.returnlessRefundAllowed,
        notes: normalized.notes,
        supersedesPolicyId: active?.id ?? null,
        createdBy: normalized.actor,
        retiredBy: null,
        retiredAt: null,
      });
      await tx.recordCommand({ idempotencyKey: normalized.idempotencyKey, requestHash, response: policy, actor: normalized.actor, createdAt: now });
      await tx.writeAudit({ actor: normalized.actor, before: active, after: policy, now });
      return { policy, replayed: false };
    });
  }
}

function validateCreateInput(input: CreateReturnPolicyInput) {
  if (!input.name.trim()) throw new ReturnPolicyAdminError("RETURN_POLICY_INVALID", "Policy name is required.", 400);
  if (!input.actor.trim()) throw new ReturnPolicyAdminError("RETURN_POLICY_INVALID", "Audit actor is required.", 400);
  if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 160) throw new ReturnPolicyAdminError("RETURN_POLICY_INVALID", "A valid idempotency key is required.", 400);
  if (!Number.isInteger(input.returnWindowDays) || input.returnWindowDays < 0 || input.returnWindowDays > 3650) throw new ReturnPolicyAdminError("RETURN_POLICY_INVALID", "Return window must be between 0 and 3650 days.", 400);
  try {
    return { ...input, name: input.name.trim(), notes: input.notes?.trim() || null, idempotencyKey: input.idempotencyKey.trim(), ...normalizeReturnPolicyScope(input) };
  } catch (error) {
    throw translateDomainError(error);
  }
}

function validateResolutionInput(input: ReturnPolicyResolutionInput): void {
  if (!Number.isInteger(input.channelId) || input.channelId <= 0) throw new ReturnPolicyAdminError("RETURN_POLICY_INVALID", "channelId must be a positive integer.", 400);
  if (input.storeConnectionId !== null && input.vendorId === null) throw new ReturnPolicyAdminError("RETURN_POLICY_INVALID", "A store resolution requires vendorId.", 400);
  if (input.businessContext === "retail" && (input.vendorId !== null || input.storeConnectionId !== null)) throw new ReturnPolicyAdminError("RETURN_POLICY_INVALID", "Retail policy resolution cannot include dropship vendor or store scope.", 400);
}

function validateReferences(scope: ReturnPolicyScopeInput, refs: ScopeReferences): void {
  if (scope.channelId !== null && !refs.channel) throw new ReturnPolicyAdminError("RETURN_POLICY_CHANNEL_NOT_FOUND", "The selected channel does not exist.", 400, { channelId: scope.channelId });
  if (scope.vendorId !== null && !refs.vendor) throw new ReturnPolicyAdminError("RETURN_POLICY_VENDOR_NOT_FOUND", "The selected vendor does not exist.", 400, { vendorId: scope.vendorId });
  if (scope.storeConnectionId !== null && !refs.store) throw new ReturnPolicyAdminError("RETURN_POLICY_STORE_NOT_FOUND", "The selected store connection does not exist.", 400, { storeConnectionId: scope.storeConnectionId });
  if (refs.store && refs.store.vendorId !== scope.vendorId) throw new ReturnPolicyAdminError("RETURN_POLICY_SCOPE_MISMATCH", "The selected store does not belong to the selected vendor.", 400);
  if (refs.store && refs.channel && refs.store.platform.toLowerCase() !== refs.channel.provider.toLowerCase()) throw new ReturnPolicyAdminError("RETURN_POLICY_SCOPE_MISMATCH", "The selected store platform does not match the selected channel provider.", 400);
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
