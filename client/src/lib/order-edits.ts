import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  orderEditCatalogCategoriesInputSchema,
  orderEditCatalogCategoriesSchema,
  orderEditCatalogProductsInputSchema,
  orderEditCatalogProductsSchema,
  orderEditCatalogVariantsInputSchema,
  orderEditCatalogVariantsSchema,
  type OrderEditCatalogCategoriesInput,
  type OrderEditCatalogProductsInput,
  type OrderEditCatalogVariantsInput,
} from "@shared/order-edits/order-edit-catalog";
import {
  orderEditPreviewInputSchema,
  orderEditPreviewScopeSchema,
  orderEditPreviewSchema,
  orderEditPreviewWarmSchema,
  type OrderEditPreview,
  type OrderEditPreviewInput,
  type OrderEditPreviewScope,
} from "@shared/order-edits/order-edit-preview";
import {
  ORDER_EDIT_API,
  ORDER_EDIT_PAGE,
  ORDER_EDIT_LINE_DISPLAY_HEADER,
  ORDER_EDIT_LINE_DISPLAY_VERSION,
  orderEditStateSchema,
  orderEditSettingsInputSchema,
  orderEditConnectionSchema,
  orderEditOrdersSchema,
  orderEditOrderSchema,
  orderEditVariantsSchema,
  orderEditQuoteInputSchema,
  orderEditOperationSchema,
  type OrderEditQuoteInput,
  type OrderEditSettingsInput,
  type OrderEditOperation,
  type OrderEditStatus,
} from "@shared/order-edits/order-edit.contract";

export const ORDER_EDITS_PATH = ORDER_EDIT_PAGE;
export const ORDER_EDITS_API = ORDER_EDIT_API;

export class OrderEditRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number | null,
    readonly uncertain: boolean,
  ) {
    super(message);
    this.name = "OrderEditRequestError";
  }
}

const serverError = z.object({
  error: z
    .union([
      z.string().min(1).max(500),
      z.object({
        message: z.string().min(1).max(500),
        code: z.string().max(100).optional(),
      }),
    ])
    .optional(),
  message: z.string().min(1).max(500).optional(),
  code: z.string().max(100).optional(),
});

/** A failed mutation can already have reached Shopify. The caller must retain its command key. */
export async function orderEditRequest<T>(
  path: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  options: {
    method?: "GET" | "POST" | "PUT";
    body?: unknown;
    key?: string;
    signal?: AbortSignal;
    /** Only the two calculation-only endpoints may use this; actual edit commands remain uncertain on lost responses. */
    calculationOnly?: boolean;
  } = {},
  request: typeof fetch = fetch,
): Promise<T> {
  const method = options.method ?? "GET";
  if (
    options.calculationOnly &&
    (method !== "POST" ||
      !["/previews", "/previews/warm"].includes(path) ||
      options.key !== undefined)
  )
    throw new OrderEditRequestError(
      "Calculation-only handling is restricted to background preview requests.",
      "ORDER_EDIT_PREVIEW_ENDPOINT_INVALID",
      null,
      false,
    );
  const mutation = method !== "GET" && !options.calculationOnly;
  const headers = new Headers({ Accept: "application/json" });
  headers.set(ORDER_EDIT_LINE_DISPLAY_HEADER, ORDER_EDIT_LINE_DISPLAY_VERSION);
  if (options.body !== undefined)
    headers.set("Content-Type", "application/json");
  if (options.key !== undefined)
    headers.set("Idempotency-Key", z.string().uuid().parse(options.key));
  let response: Response;
  try {
    response = await request(`${ORDER_EDITS_API}${path}`, {
      method,
      headers,
      credentials: "include",
      cache: "no-store",
      signal: options.signal,
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });
  } catch (error) {
    if (!mutation && error instanceof Error && error.name === "AbortError")
      throw error;
    throw new OrderEditRequestError(
      mutation
        ? "The request outcome is unknown. Check status or retry the same request."
        : "The order editor could not connect. Try again.",
      "ORDER_EDIT_CONNECTION_FAILED",
      null,
      mutation,
    );
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = serverError.safeParse(body);
    const value = parsed.success ? parsed.data : null;
    const nested =
      value?.error && typeof value.error === "object" ? value.error : null;
    throw new OrderEditRequestError(
      nested?.message ??
        (typeof value?.error === "string" ? value.error : value?.message) ??
        (response.status === 401 || response.status === 403
          ? "Order editing permission is required."
          : "The order edit request failed. Check status before retrying."),
      nested?.code ?? value?.code ?? "ORDER_EDIT_REQUEST_FAILED",
      response.status,
      mutation && response.status >= 500,
    );
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new OrderEditRequestError(
      options.calculationOnly
        ? "The background preview could not be verified. Review can still verify changes."
        : "The order edit response could not be verified. Check status before continuing.",
      "ORDER_EDIT_RESPONSE_INVALID",
      response.status,
      mutation,
    );
  }
  return parsed.data;
}

export function formatOrderEditMoney(cents: number, currency: string): string {
  if (!Number.isSafeInteger(cents) || !/^[A-Z]{3}$/.test(currency))
    return "Unavailable";
  const amount = BigInt(cents);
  const zero = BigInt(0);
  const centsPerUnit = BigInt(100);
  const magnitude = amount < zero ? -amount : amount;
  const whole = magnitude / centsPerUnit;
  const fraction = (magnitude % centsPerUnit).toString().padStart(2, "0");
  // Keep cent precision even at the safe-integer boundary. For negative amounts
  // below one dollar, use a signed placeholder to obtain the currency's sign layout.
  const signedWhole = amount < zero ? -(whole || BigInt(1)) : whole;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
    .formatToParts(signedWhole)
    .map((part) => {
      if (part.type === "fraction") return fraction;
      if (part.type === "integer" && whole === zero) return "0";
      return part.value;
    })
    .join("");
}

export function orderEditOperationFromSearch(search: string): string | null {
  const values = new URLSearchParams(search).getAll("operationId");
  return values.length === 1 && z.string().uuid().safeParse(values[0]).success
    ? values[0]
    : null;
}

const positiveId = z.number().int().positive().safe();
const operationId = z.string().uuid();
const searchText = z.string().trim().min(1).max(100);

export function safeOrderEditPaymentUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function orderEditCanCommit(
  operation: OrderEditOperation,
  now: number,
): boolean {
  return (
    operation.status === "ready" &&
    operation.error === null &&
    Number.isFinite(now) &&
    (operation.expiresAt === null || Date.parse(operation.expiresAt) > now)
  );
}

export const orderEditStatusCopy: Record<
  OrderEditStatus,
  { title: string; description: string }
> = {
  preparing: {
    title: "Preparing quote",
    description: "The proposed order changes are being verified.",
  },
  ready: {
    title: "Ready to apply",
    description:
      "Review the verified totals before applying these changes to the original order.",
  },
  committing: {
    title: "Applying changes",
    description:
      "The order change is processing. Check its status before taking another action.",
  },
  awaiting_payment: {
    title: "Awaiting payment",
    description:
      "The additional payment is outstanding. If it is not received by the deadline, automatic recovery will begin.",
  },
  refunding: {
    title: "Refund processing",
    description:
      "The order reduction is being refunded. Completion has not yet been confirmed.",
  },
  synchronizing: {
    title: "Updating fulfillment",
    description:
      "The order change is being synchronized with warehouse fulfillment.",
  },
  recovering: {
    title: "Recovering original order",
    description:
      "Recovery is in progress. The original order has not yet been confirmed restored.",
  },
  completed: {
    title: "Changes completed",
    description:
      "The order change and its required follow-up actions are complete.",
  },
  recovered: {
    title: "Original order restored",
    description:
      "The proposed changes have been recovered and the original order restored.",
  },
  review_required: {
    title: "Staff review required",
    description:
      "The operation needs investigation. Keep this operation reference and do not submit a new edit.",
  },
  failed: {
    title: "Order edit failed",
    description:
      "Review the reported error and check status before starting another edit.",
  },
  expired: {
    title: "Edit closed",
    description:
      "This unsubmitted edit is closed. No changes were applied by this edit.",
  },
};

export function createOrderEditTransport(request: typeof fetch = fetch) {
  const read = <T>(
    path: string,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    signal?: AbortSignal,
  ) => orderEditRequest(path, schema, { signal }, request);
  const operation = async (
    id: string,
    action?: "commit" | "reconcile" | "abandon",
    signal?: AbortSignal,
  ) => {
    operationId.parse(id);
    // The operation UUID is also its stable command key across reloads. Actions are separately scoped server-side.
    const result = await orderEditRequest(
      `/operations/${encodeURIComponent(id)}${action ? `/${action}` : ""}`,
      orderEditOperationSchema,
      action ? { method: "POST", key: id, body: {} } : { signal },
      request,
    );
    if (result.operationId !== id)
      throw new OrderEditRequestError(
        "The operation response did not match this order edit.",
        "ORDER_EDIT_IDENTITY_MISMATCH",
        null,
        !!action,
      );
    return result;
  };
  return {
    catalogCategories: (
      connectionId: number,
      input: OrderEditCatalogCategoriesInput,
      signal?: AbortSignal,
    ) =>
      catalogRead(
        "categories",
        connectionId,
        orderEditCatalogCategoriesInputSchema.parse(input),
        orderEditCatalogCategoriesSchema,
        signal,
      ),
    catalogProducts: (
      connectionId: number,
      input: OrderEditCatalogProductsInput,
      signal?: AbortSignal,
    ) =>
      catalogRead(
        "products",
        connectionId,
        orderEditCatalogProductsInputSchema.parse(input),
        orderEditCatalogProductsSchema,
        signal,
      ),
    catalogVariants: (
      connectionId: number,
      input: OrderEditCatalogVariantsInput,
      signal?: AbortSignal,
    ) =>
      catalogRead(
        "variants",
        connectionId,
        orderEditCatalogVariantsInputSchema.parse(input),
        orderEditCatalogVariantsSchema,
        signal,
      ),
    warmPreview: async (scope: OrderEditPreviewScope, signal?: AbortSignal) => {
      const body = orderEditPreviewScopeSchema.parse(scope);
      const result = await orderEditRequest(
        "/previews/warm",
        orderEditPreviewWarmSchema,
        { method: "POST", body, signal, calculationOnly: true },
        request,
      );
      if (canonicalJson(result.scope) !== canonicalJson(body))
        throw new OrderEditRequestError(
          "The preview context did not match this order.",
          "ORDER_EDIT_IDENTITY_MISMATCH",
          null,
          false,
        );
      return result;
    },
    preview: async (input: OrderEditPreviewInput, signal?: AbortSignal) => {
      const body = orderEditPreviewInputSchema.parse(input);
      const result = await orderEditRequest(
        "/previews",
        orderEditPreviewSchema,
        { method: "POST", body, signal, calculationOnly: true },
        request,
      );
      if (canonicalJson(result.input) !== canonicalJson(body))
        throw new OrderEditRequestError(
          "The preview did not match the current items.",
          "ORDER_EDIT_IDENTITY_MISMATCH",
          null,
          false,
        );
      return result;
    },
    state: (signal?: AbortSignal) =>
      read("/state", orderEditStateSchema, signal),
    saveSettings: async (
      connectionId: number,
      body: OrderEditSettingsInput,
      key: string,
    ) => {
      positiveId.parse(connectionId);
      const result = await orderEditRequest(
        `/settings/${connectionId}`,
        orderEditConnectionSchema,
        { method: "PUT", body: orderEditSettingsInputSchema.parse(body), key },
        request,
      );
      if (result.connectionId !== connectionId)
        throw new OrderEditRequestError(
          "The saved settings did not match the selected Shopify connection.",
          "ORDER_EDIT_IDENTITY_MISMATCH",
          null,
          true,
        );
      return result;
    },
    orders: (connectionId: number, search: string, signal?: AbortSignal) =>
      read(
        `/orders?${new URLSearchParams({
          connectionId: String(positiveId.parse(connectionId)),
          search: searchText.parse(search),
        })}`,
        orderEditOrdersSchema,
        signal,
      ),
    order: async (
      connectionId: number,
      omsOrderId: number,
      signal?: AbortSignal,
    ) => {
      const result = await read(
        `/orders/${positiveId.parse(omsOrderId)}?connectionId=${positiveId.parse(connectionId)}`,
        orderEditOrderSchema,
        signal,
      );
      if (
        result.connectionId !== connectionId ||
        result.omsOrderId !== omsOrderId
      )
        throw new OrderEditRequestError(
          "The order response did not match the selected order.",
          "ORDER_EDIT_IDENTITY_MISMATCH",
          null,
          false,
        );
      return result;
    },
    variants: (connectionId: number, search: string, signal?: AbortSignal) =>
      read(
        `/variants?${new URLSearchParams({
          connectionId: String(positiveId.parse(connectionId)),
          search: searchText.parse(search),
        })}`,
        orderEditVariantsSchema,
        signal,
      ),
    quote: (input: OrderEditQuoteInput) =>
      orderEditRequest(
        "/quotes",
        orderEditOperationSchema,
        {
          method: "POST",
          body: orderEditQuoteInputSchema.parse(input),
          key: input.requestKey,
        },
        request,
      ),
    operation: (id: string, signal?: AbortSignal) =>
      operation(id, undefined, signal),
    commit: (id: string) => operation(id, "commit"),
    reconcile: (id: string) => operation(id, "reconcile"),
    abandon: (id: string) => operation(id, "abandon"),
  };
  async function catalogRead<
    T extends { connectionId: number; input: unknown },
  >(
    endpoint: "categories" | "products" | "variants",
    connectionId: number,
    input: Record<string, string | number | null>,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const params = new URLSearchParams({
      connectionId: String(positiveId.parse(connectionId)),
    });
    for (const [key, value] of Object.entries(input))
      if (value !== null) params.set(key, String(value));
    const result = await read(`/catalog/${endpoint}?${params}`, schema, signal);
    if (
      result.connectionId !== connectionId ||
      canonicalJson(result.input) !== canonicalJson(input)
    )
      throw new OrderEditRequestError(
        "The product results did not match this store or search.",
        "ORDER_EDIT_IDENTITY_MISMATCH",
        null,
        false,
      );
    return result;
  }
}

export type OrderEditTransport = ReturnType<typeof createOrderEditTransport>;

export function matchingOrderEditPreview(
  preview: OrderEditPreview | undefined,
  input: OrderEditPreviewInput,
  now: number,
): OrderEditPreview | null {
  return preview &&
    Number.isFinite(now) &&
    Date.parse(preview.expiresAt) > now &&
    canonicalJson(preview.input) === canonicalJson(input)
    ? preview
    : null;
}

type QuoteStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const pendingQuoteKey = (staffId: string) =>
  `order-edit:pending-quote:${encodeURIComponent(z.string().min(1).max(200).parse(staffId))}`;

/** Save the bounded intent before staging a provider edit so a lost response survives a page refresh. */
export function savePendingOrderEditQuote(
  staffId: string,
  input: OrderEditQuoteInput,
  storage: QuoteStorage,
): void {
  const text = JSON.stringify(orderEditQuoteInputSchema.parse(input));
  try {
    storage.setItem(pendingQuoteKey(staffId), text);
  } catch {
    throw new Error(
      "This browser could not save the request reference. Allow session storage before preparing an order edit.",
    );
  }
}

export function loadPendingOrderEditQuote(
  staffId: string,
  storage: QuoteStorage,
): OrderEditQuoteInput | null {
  let text: string | null;
  try {
    text = storage.getItem(pendingQuoteKey(staffId));
  } catch {
    throw new Error(
      "This browser could not read its saved order edit request.",
    );
  }
  if (text === null) return null;
  try {
    if (text.length > 100_000) throw new Error("oversized saved request");
    return orderEditQuoteInputSchema.parse(JSON.parse(text));
  } catch {
    throw new Error(
      "The saved order edit request could not be verified. Contact support before preparing another edit in this browser.",
    );
  }
}

export function clearPendingOrderEditQuote(
  staffId: string,
  storage: QuoteStorage,
): void {
  storage.removeItem(pendingQuoteKey(staffId));
}
