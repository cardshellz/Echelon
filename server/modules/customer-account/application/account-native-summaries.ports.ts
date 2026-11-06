import { z } from "zod";
import type { CustomerAccountOrderSummariesInput } from "@shared/customer-account/customer-account-orders";

const externalId = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .max(30);
export const accountNativeFactSchema = z
  .object({
    channelId: z.number().int().positive().safe(),
    connectionId: z.number().int().positive().safe(),
    shopDomain: z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/),
    externalOrderId: externalId,
    orderReference: z.string().min(1).max(50),
    externalCustomerId: externalId.nullable(),
    currency: z.literal("USD"),
    totalCents: z.number().int().nonnegative().safe(),
    financialStatus: z.string().min(1).max(80),
    cancelled: z.boolean(),
    sourceUpdatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type AccountNativeFact = z.infer<typeof accountNativeFactSchema>;
export const accountNativeSourceFailureSchema = accountNativeFactSchema
  .pick({
    channelId: true,
    connectionId: true,
    shopDomain: true,
    externalOrderId: true,
    externalCustomerId: true,
    sourceUpdatedAt: true,
  })
  .extend({
    code: z.enum([
      "ACCOUNT_NATIVE_SOURCE_INVALID",
      "MONEY_INVALID",
      "MONEY_OVERFLOW",
      "CURRENCY_CONVERSION_UNSUPPORTED",
    ]),
  })
  .strict();
export type AccountNativeSourceFailure = z.infer<
  typeof accountNativeSourceFailureSchema
>;
export interface AccountNativeObservation {
  facts: readonly AccountNativeFact[];
  failures?: readonly AccountNativeSourceFailure[];
  startedAt: Date;
  finishedAt: Date;
}
export interface AccountNativeRetainer {
  retain(observation: AccountNativeObservation): Promise<void>;
}
export interface AccountNativeReader {
  read(
    input: CustomerAccountOrderSummariesInput & {
      channelId: number;
      connectionId: number;
      shopDomain: string;
      externalCustomerId: string;
    },
  ): Promise<Array<AccountNativeFact & { freshThrough: Date }>>;
  request(
    input: {
      channelId: number;
      externalCustomerId: string;
      externalOrderIds: string[];
    },
    now: Date,
  ): Promise<void>;
}
export interface AccountNativePage {
  observation: AccountNativeObservation;
  /** Scoped serialized range checkpoint, never a last-row numeric seek. Null completes the scan. */
  after: string | null;
}
export interface AccountNativeProvider {
  page(
    connectionId: number,
    after: string | null,
    since: Date | null,
  ): Promise<AccountNativePage>;
  byIds(connectionId: number, ids: string[]): Promise<AccountNativeObservation>;
}

export interface AccountNativeCursor {
  connectionId: number;
  channelId: number;
  shopDomain: string;
  leaseId: string;
  backfillAfter: string | null;
  backfillComplete: boolean;
  backfillDue: boolean;
  deltaSince: Date;
  deltaAfter: string | null;
  deltaStartedAt: Date;
  deltaDue: boolean;
}
export interface AccountNativeClaim {
  externalOrderId: string;
  generation: string;
  leaseId: string;
  attempts: number;
}
export interface AccountNativeMaintenance extends AccountNativeRetainer {
  claim(now: Date, leaseId: string): Promise<AccountNativeCursor | null>;
  claimOrders(
    cursor: AccountNativeCursor,
    now: Date,
  ): Promise<AccountNativeClaim[]>;
  completeOrders(
    cursor: AccountNativeCursor,
    claims: AccountNativeClaim[],
    observedSince: Date,
    now: Date,
  ): Promise<void>;
  completePage(
    cursor: AccountNativeCursor,
    kind: "delta" | "backfill",
    page: AccountNativePage,
    now: Date,
  ): Promise<void>;
  release(
    cursor: AccountNativeCursor,
    now: Date,
    failed: boolean,
  ): Promise<void>;
}

export class AccountNativeLeaseLostError extends Error {
  readonly code = "ACCOUNT_NATIVE_LEASE_LOST";
  constructor() {
    super("Account history maintenance lease was replaced or expired.");
  }
}
