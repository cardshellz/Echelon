import { z } from "zod";
import { customerReturnDimensionsSchema, customerReturnParcelWeightSchema } from "@shared/returns/customer-return-parcel";
import type { CustomerReturnAuthorizationAllocation, ReturnAuthorizationSnapshot } from "./customer-return-authorization.ports";
import type { ReturnPolicySnapshot } from "../domain/return-case";
import { returnLabelAddressSchema } from "../../shipping-engine/application/return-label-provider.port";

const id = z.number().int().positive().safe();
const text = (length: number) => z.string().trim().min(1).max(length);
export const customerReturnIntakeAddressSchema = returnLabelAddressSchema.extend({ countryCode: z.literal("US") });
export type CustomerReturnIntakeAddress = z.infer<typeof customerReturnIntakeAddressSchema>;

/** Server-prepared facts only. This is deliberately not an HTTP/customer DTO. */
export interface PreparedCustomerReturnIntake {
  channelId: number;
  omsOrderId: number;
  idempotencyKey: string;
  semanticHash: string;
  eligibilityRevision: string;
  actor: string;
  observedAt: string;
  settingsVersion: number;
  submissionLeaseToken: string;
  policySnapshot: ReturnAuthorizationSnapshot;
  warehouseSnapshot: ReturnAuthorizationSnapshot;
  operationalPolicy: { id: number; version: number; snapshot: ReturnPolicySnapshot };
  lines: readonly {
    omsOrderLineId: number;
    externalLineItemId: string;
    quantity: number;
    reasonCode: string | null;
    allocations: readonly CustomerReturnAuthorizationAllocation[];
  }[];
  /** Full current claim totals for every WMS item of the selected purchased lines. */
  expectedClaims: readonly { wmsOrderItemId: number; legacyExpectedQuantity: number; claimedQuantity: number }[];
  parcels: readonly {
    parcelKey: string;
    dimensions: z.infer<typeof customerReturnDimensionsSchema>;
    weightGrams: number;
    originAddress: CustomerReturnIntakeAddress;
    destinationAddress: CustomerReturnIntakeAddress;
    carrierId: string;
    serviceCode: string;
    items: readonly { omsOrderLineId: number; quantity: number }[];
  }[];
}

export const customerReturnIntakeResultSchema = z.object({
  authorizationId: id, authorizationNumber: text(32), replayed: z.boolean(),
  cases: z.array(z.object({ caseId: id, caseNumber: text(32), wmsOrderId: id, wmsReturnId: id }).strict()).min(1).max(200),
  parcels: z.array(z.object({
    parcelId: id, parcelKey: text(64), providerExternalShipmentId: text(100),
    dimensions: customerReturnDimensionsSchema, weightGrams: customerReturnParcelWeightSchema,
  }).strict()).min(1).max(20),
}).strict();
export type CustomerReturnIntakeResult = z.infer<typeof customerReturnIntakeResultSchema>;
export interface CustomerReturnIntakeStore {
  /** Replays only when channel/order/hash all agree; must be called after fresh staff authorization. */
  find(input: { channelId: number; omsOrderId: number; idempotencyKey: string; semanticHash: string }): Promise<CustomerReturnIntakeResult | null>;
  /** One transaction: lock entitlement, validate current claims/policy, root, children, manifests. */
  persist(input: PreparedCustomerReturnIntake & { now: Date }): Promise<CustomerReturnIntakeResult>;
}
export class CustomerReturnIntakeError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message);
    this.name = "CustomerReturnIntakeError";
  }
}
