import { createHash } from "node:crypto";

import {
  INVENTORY_DEMAND_METHOD_VERSION,
  INVENTORY_DEMAND_OBSERVATION_DAYS,
  promiseSafetyAdminViewSchema,
  refreshDemandEvidenceAdminRequestSchema,
  refreshDemandEvidenceAdminResultSchema,
  promiseSafetyPolicyDraftAdminResultSchema,
  updatePromiseSafetyPolicyDraftAdminRequestSchema,
  type PromiseSafetyAdminView,
  type PromiseSafetyAdminValue,
  type RefreshDemandEvidenceAdminRequest,
  type RefreshDemandEvidenceAdminResult,
  type UpdatePromiseSafetyPolicyDraftAdminRequest,
} from "@shared/types/inventory-promise-safety-admin";
import { canonicalJson } from "@shared/utils/canonical-json";
import { z } from "zod";

import { InventoryAvailabilityMasterDataError } from "../domain/inventory-availability-master-data.contracts";
import { completeUtcDemandWindow } from "../domain/inventory-demand-evidence";

const positiveDatabaseIntegerSchema = z.number().int().positive().max(2_147_483_647);
const actorSchema = z.string().trim().min(1).max(100);

export interface RefreshDemandEvidenceCommand {
  productId: number;
  actorId: string;
  changeReason: string;
  idempotencyKey: string;
  requestHash: string;
  windowStartedAt: Date;
  windowEndedAt: Date;
  calculatedAt: Date;
}

export interface UpdatePromiseSafetyPolicyDraftCommand {
  policyId: number;
  expectedVersion: number;
  expectedDefinitionHash: string;
  expectedHeadRevision: string;
  value: PromiseSafetyAdminValue;
  actorId: string;
  changeReason: string;
  idempotencyKey: string;
  requestHash: string;
  occurredAt: Date;
}

export interface InventoryPromiseSafetyAdminStore {
  getPromiseSafetyAdminView(productId: number): Promise<PromiseSafetyAdminView | null>;
  refreshDemandEvidence(command: RefreshDemandEvidenceCommand): Promise<RefreshDemandEvidenceAdminResult>;
  updatePromiseSafetyPolicyDraft(command: UpdatePromiseSafetyPolicyDraftCommand): Promise<{
    policyId: number;
    version: number;
    scopeKey: string;
    definitionHash: string;
    alreadyApplied: boolean;
  }>;
}

export interface InventoryPromiseSafetyAdminClock {
  now(): Date;
}

const systemClock: InventoryPromiseSafetyAdminClock = {
  now: () => new Date(),
};

export class InventoryPromiseSafetyAdminService {
  constructor(
    private readonly store: InventoryPromiseSafetyAdminStore,
    private readonly clock: InventoryPromiseSafetyAdminClock = systemClock,
  ) {}

  async getView(productInput: number): Promise<PromiseSafetyAdminView> {
    const productId = parseProductId(productInput);
    const view = await this.store.getPromiseSafetyAdminView(productId);
    if (!view) {
      throw new InventoryAvailabilityMasterDataError(
        404,
        "INVENTORY_PROMISE_SAFETY_PRODUCT_NOT_FOUND",
        "The selected inventory-planning product was not found.",
      );
    }
    return promiseSafetyAdminViewSchema.parse(view);
  }

  async refreshDemandEvidence(
    productInput: number,
    requestInput: RefreshDemandEvidenceAdminRequest,
    actorInput: string,
  ): Promise<RefreshDemandEvidenceAdminResult> {
    const productId = parseProductId(productInput);
    const request = parseRequest(requestInput);
    const actor = parseActor(actorInput);
    const calculatedAt = this.clock.now();
    const { windowStartedAt, windowEndedAt } = completeUtcDemandWindow(
      calculatedAt,
      INVENTORY_DEMAND_OBSERVATION_DAYS,
    );
    const requestHash = createHash("sha256").update(canonicalJson({
      commandType: "inventory_demand_evidence_refresh",
      productId,
      actor,
      changeReason: request.changeReason,
      methodVersion: INVENTORY_DEMAND_METHOD_VERSION,
      observationDays: INVENTORY_DEMAND_OBSERVATION_DAYS,
      windowStartedAt: windowStartedAt.toISOString(),
      windowEndedAt: windowEndedAt.toISOString(),
    }), "utf8").digest("hex");
    return refreshDemandEvidenceAdminResultSchema.parse(
      await this.store.refreshDemandEvidence({
        productId,
        actorId: actor,
        changeReason: request.changeReason,
        idempotencyKey: request.idempotencyKey,
        requestHash,
        windowStartedAt,
        windowEndedAt,
        calculatedAt,
      }),
    );
  }

  async updatePolicyDraft(
    policyInput: number,
    requestInput: UpdatePromiseSafetyPolicyDraftAdminRequest,
    actorInput: string,
  ) {
    const policyId = parsePositiveIdentifier(
      policyInput,
      "INVENTORY_PROMISE_SAFETY_INVALID_POLICY_ID",
      "The promise-safety policy identifier is invalid.",
    );
    const parsed = updatePromiseSafetyPolicyDraftAdminRequestSchema.safeParse(requestInput);
    if (!parsed.success) {
      throw new InventoryAvailabilityMasterDataError(
        400,
        "INVENTORY_PROMISE_SAFETY_INVALID_DRAFT_UPDATE",
        "Review the promise-safety draft fields.",
        parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`),
      );
    }
    const request = parsed.data;
    const actorId = parseActor(actorInput);
    const requestHash = createHash("sha256").update(canonicalJson({
      commandType: "promise_safety_policy_draft_update",
      policyId,
      actorId,
      expectedVersion: request.expectedVersion,
      expectedDefinitionHash: request.expectedDefinitionHash,
      expectedHeadRevision: request.expectedHeadRevision,
      value: request.value,
      changeReason: request.changeReason,
    }), "utf8").digest("hex");
    return promiseSafetyPolicyDraftAdminResultSchema.parse(
      await this.store.updatePromiseSafetyPolicyDraft({
        policyId,
        expectedVersion: request.expectedVersion,
        expectedDefinitionHash: request.expectedDefinitionHash,
        expectedHeadRevision: request.expectedHeadRevision,
        value: request.value,
        actorId,
        changeReason: request.changeReason,
        idempotencyKey: request.idempotencyKey,
        requestHash,
        occurredAt: this.clock.now(),
      }),
    );
  }
}

function parseProductId(value: number): number {
  return parsePositiveIdentifier(
    value,
    "INVENTORY_PROMISE_SAFETY_INVALID_PRODUCT_ID",
    "The inventory-planning product identifier is invalid.",
  );
}

function parsePositiveIdentifier(value: number, code: string, message: string): number {
  const parsed = positiveDatabaseIntegerSchema.safeParse(value);
  if (!parsed.success) {
    throw new InventoryAvailabilityMasterDataError(
      400,
      code,
      message,
    );
  }
  return parsed.data;
}

function parseRequest(value: RefreshDemandEvidenceAdminRequest): RefreshDemandEvidenceAdminRequest {
  const parsed = refreshDemandEvidenceAdminRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new InventoryAvailabilityMasterDataError(
      400,
      "INVENTORY_PROMISE_SAFETY_INVALID_REFRESH",
      "Review the demand-evidence refresh fields.",
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`),
    );
  }
  return parsed.data;
}

function parseActor(value: string): string {
  const parsed = actorSchema.safeParse(value);
  if (!parsed.success) {
    throw new InventoryAvailabilityMasterDataError(
      401,
      "INVENTORY_AVAILABILITY_ACTOR_REQUIRED",
      "An authenticated operator is required.",
    );
  }
  return parsed.data;
}
