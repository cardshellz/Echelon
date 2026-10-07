import { z } from "zod";
import { orderEditFinancialsSchema } from "@shared/order-edits/order-edit-financials";
import { SHOPIFY_CALCULATED_LINE_ID_PATTERN } from "@shared/order-edits/shopify-edit-identity";
import type {
  OrderEditSnapshot,
  OrderEditQuote,
  OrderEditRefundIntent,
} from "./order-edit-provider";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
const json: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(json),
    z.record(json),
  ]),
);
const text = z.string().min(1);
const money = z.number().int().safe().nonnegative();
const signedMoney = z.number().int().safe();
const quantity = z.number().int().safe().nonnegative();
const connection = z.number().int().safe().positive();
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const operationId = z.string().regex(/^[a-zA-Z0-9:_-]{1,160}$/);
const gid = (resource: string) =>
  z.string().regex(new RegExp(`^gid://shopify/${resource}/[1-9][0-9]*$`));
const transaction = z
  .object({
    id: gid("OrderTransaction"),
    parentId: gid("OrderTransaction").nullable(),
    kind: z.enum([
      "AUTHORIZATION",
      "CAPTURE",
      "SALE",
      "VOID",
      "REFUND",
      "EMV_AUTHORIZATION",
      "CHANGE",
    ]),
    status: z.enum([
      "SUCCESS",
      "FAILURE",
      "ERROR",
      "PENDING",
      "AWAITING_RESPONSE",
      "UNKNOWN",
    ]),
    gateway: text,
    amountCents: money,
    manual: z.boolean(),
  })
  .strict();
const refund = z
  .object({
    id: gid("Refund"),
    note: z.string().nullable(),
    amountCents: money,
    transactions: z.array(transaction),
  })
  .strict();
const line = z
  .object({
    id: gid("LineItem"),
    variantId: z.union([gid("ProductVariant"), z.literal("")]),
    title: text,
    variantTitle: z.string().nullable(),
    sku: z.string().nullable(),
    quantity,
    unfulfilledQuantity: quantity,
    originalUnitPriceCents: money,
    discountedUnitPriceCents: money,
    totalCents: money,
    discountFingerprint: fingerprint,
    unsupported: z.boolean(),
  })
  .strict()
  .refine(
    (value) => value.unsupported || value.variantId !== "",
    "Supported lines require a variant identity",
  );

export const orderEditSnapshotSchema: z.ZodType<OrderEditSnapshot> = z
  .object({
    financials: orderEditFinancialsSchema.optional(),
    discountRules: z
      .array(
        z
          .object({
            index: quantity,
            type: text,
            targetType: text,
            allocationMethod: text,
            targetSelection: text,
            label: text,
            value: z.discriminatedUnion("type", [
              z
                .object({
                  type: z.literal("percentage"),
                  percentage: z.number().finite().min(0).max(100),
                })
                .strict(),
              z
                .object({ type: z.literal("fixed"), amountCents: money })
                .strict(),
            ]),
          })
          .strict(),
      )
      .optional(),
    paymentDates: z.record(z.string().datetime().nullable()).optional(),
    connectionId: connection,
    channelId: connection,
    orderId: gid("Order"),
    name: text,
    customerId: gid("Customer").nullable(),
    currency: z.literal("USD"),
    updatedAt: z.string().datetime(),
    editable: z.boolean(),
    editableErrors: z.array(z.string()),
    cancelled: z.boolean(),
    closed: z.boolean(),
    fullyPaid: z.boolean(),
    totalCents: money,
    outstandingCents: signedMoney,
    subtotalCents: money,
    taxCents: money,
    netPaidCents: money,
    capturableCents: money,
    shippingCents: money,
    paymentUrl: z
      .string()
      .url()
      .refine((value) => {
        const parsed = new URL(value);
        return (
          parsed.protocol === "https:" &&
          !parsed.username &&
          !parsed.password &&
          !parsed.port
        );
      })
      .nullable(),
    memberPlan: text.nullable(),
    memberPricingEnabled: z.boolean(),
    discountsPresent: z.boolean(),
    lines: z.array(line),
    transactions: z.array(transaction),
    refunds: z.array(refund),
    contentFingerprint: fingerprint,
    fingerprint,
    evidence: z
      .object({
        shippingAddressFingerprint: fingerprint,
        countryCode: z.string().nullable(),
        discountApplications: z.array(json),
        unsupportedPaymentTerms: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    // Zod still runs refinements after an integer validation issue. Do not
    // convert malformed monetary or quantity input to BigInt and throw.
    if (
      value.lines.some(
        (entry) =>
          !Number.isSafeInteger(entry.originalUnitPriceCents) ||
          !Number.isSafeInteger(entry.quantity),
      ) ||
      value.financials?.lines.some(
        (entry) => !Number.isSafeInteger(entry.grossCents),
      )
    )
      return;
    if (
      value.financials &&
      (value.financials.totalCents !== value.totalCents ||
        value.financials.itemsNetCents !== value.subtotalCents ||
        value.financials.taxCents !== value.taxCents ||
        value.financials.shippingCents !== value.shippingCents ||
        value.financials.lines.length !== value.lines.length ||
        value.lines.some(
          (line) =>
            !value.financials!.lines.some(
              (entry) =>
                entry.id === line.id &&
                BigInt(entry.grossCents) ===
                  BigInt(line.originalUnitPriceCents) * BigInt(line.quantity),
            ),
        ))
    )
      context.addIssue({
        code: "custom",
        message:
          "Snapshot financial breakdown does not match its order and lines.",
      });
    if (
      new Set(value.lines.map((entry) => entry.id)).size !== value.lines.length
    )
      context.addIssue({
        code: "custom",
        message: "Duplicate line identities",
      });
    if (
      new Set(value.transactions.map((entry) => entry.id)).size !==
      value.transactions.length
    )
      context.addIssue({
        code: "custom",
        message: "Duplicate transaction identities",
      });
  });

const plan = z
  .object({
    changes: z
      .array(
        z
          .object({
            lineItemId: z.union([
              gid("LineItem"),
              z.string().regex(/^[1-9][0-9]*$/),
            ]),
            quantity,
          })
          .strict(),
      )
      .max(250),
    additions: z
      .array(
        z
          .object({
            variantId: z.union([
              gid("ProductVariant"),
              z.string().regex(/^[1-9][0-9]*$/),
            ]),
            quantity: quantity.positive(),
          })
          .strict(),
      )
      .max(250),
  })
  .strict();
export const orderEditQuoteSchema: z.ZodType<OrderEditQuote> = z
  .object({
    financials: orderEditFinancialsSchema.optional(),
    connectionId: connection,
    channelId: connection,
    orderId: gid("Order"),
    operationId,
    calculatedOrderId: gid("CalculatedOrder"),
    sessionId: gid("OrderEditSession"),
    baselineFingerprint: fingerprint,
    baseline: orderEditSnapshotSchema,
    plan,
    lines: z.array(
      z
        .object({
          title: text,
          variantTitle: z.string().nullable(),
          originalLineId: gid("LineItem").nullable(),
          quantityIncreaseOfLineId: gid("LineItem").optional(),
          calculatedLineId: z
            .string()
            .regex(SHOPIFY_CALCULATED_LINE_ID_PATTERN),
          variantId: gid("ProductVariant"),
          quantity,
          originalUnitPriceCents: money,
          discountedUnitPriceCents: money,
          totalCents: money,
        })
        .strict(),
    ),
    totalCents: money,
    outstandingCents: signedMoney,
    deltaCents: signedMoney,
    shippingCents: money,
    createdAt: z.string().datetime(),
    evidence: z.record(json),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      ![
        value.totalCents,
        value.baseline.totalCents,
        value.baseline.netPaidCents,
        value.deltaCents,
        value.outstandingCents,
      ].every(Number.isSafeInteger) ||
      value.lines.some(
        (entry) =>
          !Number.isSafeInteger(entry.originalUnitPriceCents) ||
          !Number.isSafeInteger(entry.quantity),
      ) ||
      value.financials?.lines.some(
        (entry) => !Number.isSafeInteger(entry.grossCents),
      )
    )
      return;
    if (
      value.financials &&
      (value.financials.totalCents !== value.totalCents ||
        value.financials.shippingCents !== value.shippingCents ||
        value.financials.lines.length !== value.lines.length ||
        value.lines.some(
          (line) =>
            !value.financials!.lines.some(
              (entry) =>
                entry.id === line.calculatedLineId &&
                BigInt(entry.grossCents) ===
                  BigInt(line.originalUnitPriceCents) * BigInt(line.quantity),
            ),
        ))
    ) {
      context.addIssue({
        code: "custom",
        message: "Quote financial breakdown does not match its total.",
      });
    }
    if (
      value.orderId !== value.baseline.orderId ||
      value.connectionId !== value.baseline.connectionId ||
      value.channelId !== value.baseline.channelId ||
      value.baselineFingerprint !== value.baseline.fingerprint
    )
      context.addIssue({
        code: "custom",
        message: "Quote baseline identity does not match",
      });
    if (
      BigInt(value.totalCents) - BigInt(value.baseline.totalCents) !==
      BigInt(value.deltaCents)
    )
      context.addIssue({
        code: "custom",
        message: "Quote delta does not match its totals",
      });
    if (
      BigInt(value.totalCents) - BigInt(value.baseline.netPaidCents) !==
      BigInt(value.outstandingCents)
    )
      context.addIssue({
        code: "custom",
        message: "Quote outstanding amount does not match",
      });
    if (
      new Set(value.lines.map((entry) => entry.calculatedLineId)).size !==
      value.lines.length
    )
      context.addIssue({
        code: "custom",
        message: "Duplicate calculated line identities",
      });
    const canonical = (resource: string, id: string) =>
      id.startsWith("gid://") ? id : `gid://shopify/${resource}/${id}`;
    const changes = new Map(
      value.plan.changes.map((entry) => [
        canonical("LineItem", entry.lineItemId),
        entry.quantity,
      ]),
    );
    const additions = new Map(
      value.plan.additions.map((entry) => [
        canonical("ProductVariant", entry.variantId),
        entry.quantity,
      ]),
    );
    if (
      changes.size !== value.plan.changes.length ||
      additions.size !== value.plan.additions.length
    )
      context.addIssue({
        code: "custom",
        message: "Duplicate planned line identities",
      });
    const expectedOriginals = value.lines.filter(
      (entry) => entry.originalLineId !== null,
    );
    const increases = value.lines.filter(
      (entry) => entry.quantityIncreaseOfLineId !== undefined,
    );
    const increaseByOriginal = new Map(
      increases.map((entry) => [entry.quantityIncreaseOfLineId!, entry]),
    );
    if (
      increaseByOriginal.size !== increases.length ||
      increases.some((entry) => {
        const original = value.baseline.lines.find(
          (line) => line.id === entry.quantityIncreaseOfLineId,
        );
        const requested = original && changes.get(original.id);
        return (
          entry.originalLineId !== null ||
          !original ||
          original.quantity <= 0 ||
          requested === undefined ||
          requested <= original.quantity ||
          entry.variantId !== original.variantId ||
          entry.quantity !==
            requested -
              original.quantity +
              (additions.get(entry.variantId) ?? 0)
        );
      })
    )
      context.addIssue({
        code: "custom",
        message:
          "Quoted quantity increases do not conserve the requested quantities",
      });
    const requiredOriginals = value.baseline.lines.filter(
      (entry) => entry.quantity > 0 || changes.has(entry.id),
    );
    if (
      expectedOriginals.length !== requiredOriginals.length ||
      new Set(expectedOriginals.map((entry) => entry.originalLineId)).size !==
        expectedOriginals.length ||
      requiredOriginals.some(
        (entry) =>
          !expectedOriginals.some(
            (expected) =>
              expected.originalLineId === entry.id &&
              expected.variantId === entry.variantId &&
              expected.quantity ===
                (increaseByOriginal.has(entry.id)
                  ? entry.quantity
                  : (changes.get(entry.id) ?? entry.quantity)) &&
              expected.originalUnitPriceCents === entry.originalUnitPriceCents,
          ),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Quoted original lines do not match the saved plan",
      });
    }
    if (
      [...changes.keys()].some(
        (id) => !value.baseline.lines.some((entry) => entry.id === id),
      )
    )
      context.addIssue({
        code: "custom",
        message: "Plan changes an unknown original line",
      });
    const expectedAdditions = value.lines.filter(
      (entry) => entry.originalLineId === null,
    );
    if (
      expectedAdditions.length !==
        new Set([
          ...additions.keys(),
          ...increases.map((entry) => entry.variantId),
        ]).size ||
      new Set(expectedAdditions.map((entry) => entry.variantId)).size !==
        expectedAdditions.length ||
      expectedAdditions.some(
        (entry) =>
          !entry.quantityIncreaseOfLineId &&
          additions.get(entry.variantId) !== entry.quantity,
      )
    )
      context.addIssue({
        code: "custom",
        message: "Quoted additions do not match the saved plan",
      });
    if (
      !value.lines.some((entry) => entry.quantity > 0) ||
      value.lines.some(
        (entry) => entry.quantity === 0 && entry.totalCents !== 0,
      )
    )
      context.addIssue({
        code: "custom",
        message: "Invalid quoted line totals",
      });
  });

export const orderEditRefundIntentSchema: z.ZodType<OrderEditRefundIntent> = z
  .object({
    connectionId: connection,
    channelId: connection,
    orderId: gid("Order"),
    operationId,
    idempotencyKey: operationId,
    currency: z.literal("USD"),
    amountCents: money.positive(),
    parentTransactionId: gid("OrderTransaction"),
    gateway: text,
    note: text,
    contentFingerprint: fingerprint,
  })
  .strict()
  .refine(
    (value) => value.note === `Echelon order edit ${value.operationId}`,
    "Refund note must identify its durable operation",
  );
