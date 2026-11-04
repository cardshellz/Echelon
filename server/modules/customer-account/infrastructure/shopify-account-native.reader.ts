import { z } from "zod";
import { shopifyMoneyBagCents } from "../../order-edits/infrastructure/shopify-order-edit-money";
import type { OrderEditCredentials } from "../../order-edits/application/order-edit-provider";
import {
  accountNativeFactSchema,
  accountNativeSourceFailureSchema,
  type AccountNativeFact,
  type AccountNativeSourceFailure,
} from "../application/account-native-summaries.ports";

const money = z.object({ amount: z.string(), currencyCode: z.literal("USD") });
export const accountNativeNodeSchema = z.object({
  id: z.string().regex(/^gid:\/\/shopify\/Order\/[1-9][0-9]*$/),
  name: z.string().min(1).max(50),
  updatedAt: z.string().datetime({ offset: true }),
  customer: z
    .object({
      id: z.string().regex(/^gid:\/\/shopify\/Customer\/[1-9][0-9]*$/),
    })
    .nullable(),
  cancelledAt: z.string().nullable(),
  displayFinancialStatus: z.enum([
    "AUTHORIZED",
    "EXPIRED",
    "PAID",
    "PARTIALLY_PAID",
    "PARTIALLY_REFUNDED",
    "PENDING",
    "REFUNDED",
    "VOIDED",
  ]),
  currentTotalPriceSet: z.object({ presentmentMoney: money, shopMoney: money }),
});
export function accountNativeFact(
  credentials: OrderEditCredentials,
  raw: unknown,
): AccountNativeFact {
  const order = accountNativeNodeSchema.parse(raw);
  // Use the same exact decimal-money reader as native order editing. Do not
  // subtract refunds or infer the current total from historic transactions.
  const financial = order.displayFinancialStatus
    .toLowerCase()
    .replaceAll("_", " ");
  return accountNativeFactSchema.parse({
    channelId: credentials.channelId,
    connectionId: credentials.connectionId,
    shopDomain: credentials.shopDomain,
    externalOrderId: order.id.split("/").at(-1),
    externalCustomerId: order.customer?.id.split("/").at(-1) ?? null,
    orderReference: order.name,
    sourceUpdatedAt: order.updatedAt,
    currency: "USD",
    totalCents: shopifyMoneyBagCents(order.currentTotalPriceSet),
    financialStatus: financial.charAt(0).toUpperCase() + financial.slice(1),
    cancelled: order.cancelledAt !== null,
  });
}

/** Identity/version must be provable even when one purchase's money is unsupported.
 * Isolate that purchase; never invent its amount or stall unrelated purchases. */
export function accountNativeObservationNode(
  credentials: OrderEditCredentials,
  raw: unknown,
): {
  fact?: AccountNativeFact;
  failure?: AccountNativeSourceFailure;
  externalOrderId: string;
} {
  const identity = accountNativeNodeSchema
    .pick({ id: true, updatedAt: true })
    .parse(raw);
  const externalOrderId = identity.id.split("/").at(-1)!;
  try {
    return { fact: accountNativeFact(credentials, raw), externalOrderId };
  } catch (error) {
    const code =
      error instanceof z.ZodError
        ? "ACCOUNT_NATIVE_SOURCE_INVALID"
        : error instanceof Error &&
            "code" in error &&
            [
              "MONEY_INVALID",
              "MONEY_OVERFLOW",
              "CURRENCY_CONVERSION_UNSUPPORTED",
            ].includes(String(error.code))
          ? String(error.code)
          : null;
    if (!code) throw error;
    const customer = accountNativeNodeSchema.shape.customer.safeParse(
      typeof raw === "object" && raw !== null && "customer" in raw
        ? raw.customer
        : null,
    );
    const owner = customer.success
      ? (customer.data?.id.split("/").at(-1) ?? null)
      : null;
    const externalCustomerId =
      owner !== null && /^[1-9][0-9]{0,29}$/.test(owner) ? owner : null;
    return {
      externalOrderId,
      failure: accountNativeSourceFailureSchema.parse({
        externalCustomerId,
        channelId: credentials.channelId,
        connectionId: credentials.connectionId,
        shopDomain: credentials.shopDomain,
        externalOrderId,
        sourceUpdatedAt: identity.updatedAt,
        code,
      }),
    };
  }
}
