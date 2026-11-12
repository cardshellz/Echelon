import { z } from "zod";
import { MAX_ORDER_EDIT_CODES } from "./order-edit-codes";

export const ORDER_EDIT_PUBLIC_CODE_ERROR_CODES = [
  "ORDER_EDIT_CODE_EMPTY",
  "ORDER_EDIT_CODE_DUPLICATE_INPUT",
  "ORDER_EDIT_CODES_LIMIT",
  "ORDER_EDIT_CODE_ALREADY_APPLIED",
  "ORDER_EDIT_NATIVE_COUPON_REDEMPTION_UNAVAILABLE",
  "ORDER_EDIT_CODE_NOT_FOUND",
  "ORDER_EDIT_CODE_INELIGIBLE",
  "ORDER_EDIT_CODE_NO_SAVING",
  "ORDER_EDIT_CODE_COMBINATION_NOT_ALLOWED",
  "ORDER_EDIT_CODE_SCOPE_UNSUPPORTED",
  "ORDER_EDIT_CODE_UNUSED_CREDIT",
  "ORDER_EDIT_CODES_UNAVAILABLE",
  "ORDER_EDIT_CODE_VERIFICATION_FAILED",
] as const;

export type OrderEditPublicCodeErrorCode =
  (typeof ORDER_EDIT_PUBLIC_CODE_ERROR_CODES)[number];

export const orderEditPublicCodeErrorCodeSchema = z.enum(
  ORDER_EDIT_PUBLIC_CODE_ERROR_CODES,
);

/**
 * Strictly bounded scalar parameters safe for public coupon presentation.
 * Never carries HTML, URLs, customer PII, or raw provider diagnostics.
 */
export const orderEditCodeErrorParamsSchema = z
  .object({
    maxCodes: z.number().int().positive().max(20).optional(),
  })
  .strict();

export type OrderEditCodeErrorParams = z.infer<
  typeof orderEditCodeErrorParamsSchema
>;

/**
 * Plain-text message template validator for theme/locale overrides.
 * Rejects control characters and angle brackets (`<`/`>`) so templates cannot inject markup.
 */
export const orderEditCodeMessageTemplateSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine(
    (value) => !/[\u0000-\u001f\u007f<>]/.test(value),
    "Code message template must be plain text without HTML tags or control characters.",
  );

export const orderEditCodeMessageCatalogSchema = z
  .object({
    ORDER_EDIT_CODE_EMPTY: orderEditCodeMessageTemplateSchema.optional(),
    ORDER_EDIT_CODE_DUPLICATE_INPUT: orderEditCodeMessageTemplateSchema.optional(),
    ORDER_EDIT_CODES_LIMIT: orderEditCodeMessageTemplateSchema.optional(),
    ORDER_EDIT_CODE_ALREADY_APPLIED: orderEditCodeMessageTemplateSchema.optional(),
    ORDER_EDIT_NATIVE_COUPON_REDEMPTION_UNAVAILABLE:
      orderEditCodeMessageTemplateSchema.optional(),
    ORDER_EDIT_CODE_NOT_FOUND: orderEditCodeMessageTemplateSchema.optional(),
    ORDER_EDIT_CODE_INELIGIBLE: orderEditCodeMessageTemplateSchema.optional(),
    ORDER_EDIT_CODE_NO_SAVING: orderEditCodeMessageTemplateSchema.optional(),
    ORDER_EDIT_CODE_COMBINATION_NOT_ALLOWED:
      orderEditCodeMessageTemplateSchema.optional(),
    ORDER_EDIT_CODE_SCOPE_UNSUPPORTED: orderEditCodeMessageTemplateSchema.optional(),
    ORDER_EDIT_CODE_UNUSED_CREDIT: orderEditCodeMessageTemplateSchema.optional(),
    ORDER_EDIT_CODES_UNAVAILABLE: orderEditCodeMessageTemplateSchema.optional(),
    ORDER_EDIT_CODE_VERIFICATION_FAILED:
      orderEditCodeMessageTemplateSchema.optional(),
  })
  .strict();

export type OrderEditCodeMessageCatalog = z.infer<
  typeof orderEditCodeMessageCatalogSchema
>;

export const DEFAULT_ORDER_EDIT_CODE_MESSAGES: Readonly<
  Record<OrderEditPublicCodeErrorCode, string>
> = Object.freeze({
  ORDER_EDIT_CODE_EMPTY: "Enter a discount code.",
  ORDER_EDIT_CODE_DUPLICATE_INPUT: "This code has already been added.",
  ORDER_EDIT_CODES_LIMIT: "You can add up to {maxCodes} codes.",
  ORDER_EDIT_CODE_ALREADY_APPLIED:
    "This discount is already on your order or in your changes.",
  ORDER_EDIT_NATIVE_COUPON_REDEMPTION_UNAVAILABLE:
    "This code has a usage limit and can only be applied at checkout. It can't be added to an existing order. Clear the code to continue editing; your order has not changed.",
  ORDER_EDIT_CODE_NOT_FOUND:
    "Enter a valid, active discount code.",
  ORDER_EDIT_CODE_INELIGIBLE:
    "This discount code is not eligible for the items in your changes.",
  ORDER_EDIT_CODE_NO_SAVING:
    "This discount code does not reduce the price of the items in your changes.",
  ORDER_EDIT_CODE_COMBINATION_NOT_ALLOWED:
    "This discount code can't be combined with the discounts on your order.",
  ORDER_EDIT_CODE_SCOPE_UNSUPPORTED:
    "This discount code can only be applied at checkout.",
  ORDER_EDIT_CODE_UNUSED_CREDIT:
    "This code's value exceeds your eligible item subtotal and can't be partially applied.",
  ORDER_EDIT_CODES_UNAVAILABLE:
    "Discount codes are temporarily unavailable. Your order has not changed.",
  ORDER_EDIT_CODE_VERIFICATION_FAILED:
    "This code could not be verified. Please try again.",
});

export class OrderEditCodeInputError extends Error {
  readonly code: OrderEditPublicCodeErrorCode;
  readonly params?: OrderEditCodeErrorParams;

  constructor(
    code: OrderEditPublicCodeErrorCode,
    params?: OrderEditCodeErrorParams,
  ) {
    const message = formatOrderEditCodeTemplate(
      DEFAULT_ORDER_EDIT_CODE_MESSAGES[code],
      params,
    );
    super(message);
    this.name = "OrderEditCodeInputError";
    this.code = code;
    this.params = params;
  }
}

export function formatOrderEditCodeTemplate(
  template: string,
  params?: OrderEditCodeErrorParams,
): string {
  const safeParams = orderEditCodeErrorParamsSchema.safeParse(params);
  const maxCodes = safeParams.success && safeParams.data.maxCodes !== undefined
    ? safeParams.data.maxCodes
    : MAX_ORDER_EDIT_CODES;
  return template.replace(/\{maxCodes\}/g, String(maxCodes));
}

export function extractPublicOrderEditCodeErrorParams(
  code: string,
  rawParams?: unknown,
): OrderEditCodeErrorParams | undefined {
  if (rawParams !== undefined) {
    const parsed = orderEditCodeErrorParamsSchema.safeParse(rawParams);
    if (parsed.success && Object.keys(parsed.data).length > 0) {
      return parsed.data;
    }
  }
  if (code === "ORDER_EDIT_CODES_LIMIT") {
    return { maxCodes: MAX_ORDER_EDIT_CODES };
  }
  return undefined;
}

/**
 * Resolves a coupon/discount error into safe user-facing plain text:
 * 1. If the storefront/theme supplies a validated override for a known public code,
 *    interpolates bounded scalar parameters (`{maxCodes}`) into that template.
 * 2. Otherwise preserves server/client English fallback messages for unconfigured
 *    themes, staff screens, and older bundles.
 */
export function resolveOrderEditCodeErrorMessage(
  cause: unknown,
  catalog?: OrderEditCodeMessageCatalog,
): string {
  const record =
    typeof cause === "object" && cause !== null
      ? (cause as { code?: unknown; params?: unknown; message?: unknown })
      : null;

  const parsedCode = orderEditPublicCodeErrorCodeSchema.safeParse(record?.code);
  const code = parsedCode.success ? parsedCode.data : null;
  const params = code
    ? extractPublicOrderEditCodeErrorParams(code, record?.params)
    : undefined;

  if (code && catalog?.[code]) {
    const templateCheck = orderEditCodeMessageTemplateSchema.safeParse(
      catalog[code],
    );
    if (templateCheck.success) {
      return formatOrderEditCodeTemplate(templateCheck.data, params);
    }
  }

  if (cause instanceof OrderEditCodeInputError) {
    return formatOrderEditCodeTemplate(
      DEFAULT_ORDER_EDIT_CODE_MESSAGES[cause.code],
      params,
    );
  }

  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }

  if (code) {
    return formatOrderEditCodeTemplate(
      DEFAULT_ORDER_EDIT_CODE_MESSAGES[code],
      params,
    );
  }

  if (catalog?.ORDER_EDIT_CODE_VERIFICATION_FAILED) {
    const fallbackTemplate = orderEditCodeMessageTemplateSchema.safeParse(
      catalog.ORDER_EDIT_CODE_VERIFICATION_FAILED,
    );
    if (fallbackTemplate.success) {
      return formatOrderEditCodeTemplate(fallbackTemplate.data);
    }
  }

  return DEFAULT_ORDER_EDIT_CODE_MESSAGES.ORDER_EDIT_CODE_VERIFICATION_FAILED;
}
