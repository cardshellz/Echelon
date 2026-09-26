import { z } from "zod";
import { customerReturnDimensionsSchema, customerReturnParcelWeightSchema } from "@shared/returns/customer-return-parcel";
import { returnLabelProviderIdSchema } from "../../shipping-engine/application/return-label-provider.port";
import { parseReturnPolicySnapshot } from "../domain/return-case-actions";
import {
  CustomerReturnIntakeError, customerReturnIntakeAddressSchema, customerReturnIntakeResultSchema,
  type CustomerReturnIntakeStore, type CustomerReturnIntakeResult, type PreparedCustomerReturnIntake
} from "./customer-return-intake.ports";

const id = z.number().int().positive().safe();
const quantity = id.max(2_147_483_647);
const nonnegative = z.number().int().nonnegative().safe();
const text = (max: number) => z.string().trim().min(1).max(max);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const snapshot = z.record(z.unknown());
export const preparedCustomerReturnIntakeSchema = z.object({
  channelId: id, omsOrderId: id, idempotencyKey: z.string().uuid(), semanticHash: hash, eligibilityRevision: hash,
  actor: text(255), observedAt: z.string().datetime({ offset: true }), settingsVersion: id, submissionLeaseToken: z.string().uuid(),
  policySnapshot: snapshot, warehouseSnapshot: snapshot,
  operationalPolicy: z.object({ id, version: id, snapshot }).strict(),
  lines: z.array(z.object({
    omsOrderLineId: id, externalLineItemId: text(100), quantity, reasonCode: text(100).nullable(),
    allocations: z.array(z.object({
      wmsOrderItemId: id, fulfillmentId: text(200), fulfillmentLineItemId: text(200),
      quantity, originalQuantity: quantity, eligibleQuantity: quantity, deliveryEvidence: snapshot,
    }).strict()).min(1).max(200),
  }).strict()).min(1).max(200),
  expectedClaims: z.array(z.object({ wmsOrderItemId: id, legacyExpectedQuantity: nonnegative, claimedQuantity: nonnegative }).strict()).min(1).max(40_000),
  parcels: z.array(z.object({
    parcelKey: text(64), dimensions: customerReturnDimensionsSchema, weightGrams: customerReturnParcelWeightSchema,
    originAddress: customerReturnIntakeAddressSchema, destinationAddress: customerReturnIntakeAddressSchema,
    carrierId: returnLabelProviderIdSchema, serviceCode: z.string().regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/).max(100),
    items: z.array(z.object({ omsOrderLineId: id, quantity }).strict()).min(1).max(200),
  }).strict()).min(1).max(20),
}).strict();

/** Server-only boundary. Detach the validated facts before acquiring asynchronous locks. */
export function validatePreparedCustomerReturnIntake(raw: unknown): PreparedCustomerReturnIntake {
  const parsed = preparedCustomerReturnIntakeSchema.safeParse(raw);
  if (!parsed.success) invalid();
  const input = parsed.data;
  if (new Set(input.lines.map(line => line.omsOrderLineId)).size !== input.lines.length
    || new Set(input.lines.map(line => line.externalLineItemId)).size !== input.lines.length
    || new Set(input.expectedClaims.map(item => item.wmsOrderItemId)).size !== input.expectedClaims.length
    || new Set(input.parcels.map(parcel => parcel.parcelKey)).size !== input.parcels.length) invalid();
  const totals = new Map<number, number>();
  for (const [index, parcel] of input.parcels.entries()) {
    if (parcel.parcelKey !== String(index + 1)) invalid();
    if (new Set(parcel.items.map(item => item.omsOrderLineId)).size !== parcel.items.length) invalid();
    for (const item of parcel.items) {
      if (!input.lines.some(line => line.omsOrderLineId === item.omsOrderLineId)) invalid();
      totals.set(item.omsOrderLineId, checkedAdd(totals.get(item.omsOrderLineId) ?? 0, item.quantity));
    }
  }
  for (const line of input.lines) {
    if (totals.get(line.omsOrderLineId) !== line.quantity
      || line.allocations.reduce((sum, item) => checkedAdd(sum, item.quantity), 0) !== line.quantity
      || new Set(line.allocations.map(item => JSON.stringify([item.wmsOrderItemId, item.fulfillmentId, item.fulfillmentLineItemId]))).size !== line.allocations.length) invalid();
  }
  if (input.parcels.length > input.lines.reduce((sum, line) => checkedAdd(sum, line.quantity), 0)) invalid();
  const policy = parseReturnPolicySnapshot(input.operationalPolicy.snapshot);
  if (policy.id !== input.operationalPolicy.id || policy.version !== input.operationalPolicy.version
    || policy.returnDestination !== "card_shellz" || policy.labelProvider !== "shipstation"
    || policy.approvalAuthority !== "card_shellz" || policy.returnShippingPayer !== "card_shellz"
    || policy.vendorSettlementTrigger !== "none" || input.policySnapshot.refundAuthority !== "manual_shopify") invalid();
  return structuredClone({ ...input, operationalPolicy: { ...input.operationalPolicy, snapshot: policy } }) as PreparedCustomerReturnIntake;
}

export class CustomerReturnIntakeService {
  constructor(private readonly dependencies: {
    store: CustomerReturnIntakeStore; now: () => Date;
    isIntakeReady: () => boolean; maxSourceAgeMs: number; reportFailure?: (event: { code: string }) => void;
  }) { id.parse(dependencies.maxSourceAgeMs); }

  async submit(raw: PreparedCustomerReturnIntake): Promise<CustomerReturnIntakeResult> {
    try {
      const input = validatePreparedCustomerReturnIntake(raw);
      const replay = await this.dependencies.store.find(input);
      if (replay) return customerReturnIntakeResultSchema.parse(replay);
      if (!this.dependencies.isIntakeReady()) throw new CustomerReturnIntakeError("RETURN_INTAKE_NOT_READY", "Return label generation is paused.", 503);
      const now = this.dependencies.now();
      const age = now.getTime() - Date.parse(input.observedAt);
      if (!Number.isFinite(age) || age < 0 || age > this.dependencies.maxSourceAgeMs) {
        throw new CustomerReturnIntakeError("RETURN_INTAKE_SOURCE_CHANGED", "Refresh this return before generating labels.");
      }
      return customerReturnIntakeResultSchema.parse(await this.dependencies.store.persist({ ...input, now }));
    } catch (error) {
      const classified = error instanceof CustomerReturnIntakeError ? error
        : new CustomerReturnIntakeError("RETURN_INTAKE_UNAVAILABLE", "The return could not be saved. Retry the same request.", 503);
      try {
        if (this.dependencies.reportFailure) this.dependencies.reportFailure({ code: classified.code });
        else console.error("RETURN_INTAKE_FAILED", { code: classified.code });
      } catch { /* Reporting must not change command outcome. */ }
      throw classified;
    }
  }
}
function checkedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) invalid();
  return result;
}
function invalid(): never { throw new CustomerReturnIntakeError("RETURN_INTAKE_INPUT_INVALID", "Return quantities or policy details are inconsistent.", 400); }
