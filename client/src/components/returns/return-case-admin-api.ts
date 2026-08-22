import { z } from "zod";

const MAX_RECEIPT_LINES = 200;
const MAX_NOTES_LENGTH = 2_000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 160;

const positiveSafeIntegerSchema = z.number().int().positive().safe();
const nonNegativeSafeIntegerSchema = z.number().int().nonnegative().safe();
const requiredTextSchema = z.string().trim().min(1);
const nullableTextSchema = z.string().nullable();
const nullableRequiredTextSchema = z.string().trim().min(1).nullable();
const dateTimeSchema = z.string().datetime({ offset: true });

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(jsonValueSchema),
]));

export const returnCaseActionKindSchema = z.enum(["record_receipt", "start_inspection"]);
export const returnCaseActionStateSchema = z.enum([
  "available",
  "blocked",
  "completed",
  "not_applicable",
]);
export const returnCaseReceiptStatusSchema = z.enum([
  "expected",
  "partially_received",
  "received",
]);

export const returnCaseActionSchema = z.object({
  kind: returnCaseActionKindSchema,
  label: requiredTextSchema,
  description: requiredTextSchema,
  state: returnCaseActionStateSchema,
  reasonCode: z.string().trim().min(1).max(160).nullable(),
}).strict();

export const returnCaseReceiptSummarySchema = z.object({
  expectedUnits: nonNegativeSafeIntegerSchema,
  receivedUnits: nonNegativeSafeIntegerSchema,
  remainingUnits: nonNegativeSafeIntegerSchema,
  fullyReceived: z.boolean(),
  partiallyReceived: z.boolean(),
}).strict().superRefine((summary, context) => {
  if (!Number.isSafeInteger(summary.receivedUnits + summary.remainingUnits)
    || summary.expectedUnits !== summary.receivedUnits + summary.remainingUnits) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Receipt totals are inconsistent.",
      path: ["expectedUnits"],
    });
  }
  if (summary.fullyReceived !== (summary.expectedUnits > 0 && summary.remainingUnits === 0)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "fullyReceived is inconsistent with the receipt totals.",
      path: ["fullyReceived"],
    });
  }
  if (summary.partiallyReceived !== (summary.receivedUnits > 0 && summary.remainingUnits > 0)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "partiallyReceived is inconsistent with the receipt totals.",
      path: ["partiallyReceived"],
    });
  }
});

export const returnCaseActionPlanSchema = z.object({
  nextAction: returnCaseActionKindSchema.nullable(),
  receiptSummary: returnCaseReceiptSummarySchema,
  actions: z.array(returnCaseActionSchema).max(returnCaseActionKindSchema.options.length),
}).strict().superRefine((plan, context) => {
  const seenKinds = new Set<string>();
  for (const [index, action] of plan.actions.entries()) {
    if (seenKinds.has(action.kind)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "An action kind may only appear once.",
        path: ["actions", index, "kind"],
      });
    }
    seenKinds.add(action.kind);
  }
  if (plan.nextAction !== null) {
    const next = plan.actions.find((action) => action.kind === plan.nextAction);
    if (!next || next.state !== "available") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "nextAction must identify a server-provided available action.",
        path: ["nextAction"],
      });
    }
  }
});

export const returnCaseDetailItemSchema = z.object({
  id: positiveSafeIntegerSchema,
  wmsReturnItemId: positiveSafeIntegerSchema,
  omsOrderLineId: positiveSafeIntegerSchema.nullable(),
  wmsOrderItemId: positiveSafeIntegerSchema.nullable(),
  externalLineItemId: nullableRequiredTextSchema,
  sku: nullableRequiredTextSchema,
  title: nullableTextSchema,
  quantity: positiveSafeIntegerSchema,
  expectedQuantity: positiveSafeIntegerSchema,
  receivedQuantity: nonNegativeSafeIntegerSchema,
  remainingQuantity: nonNegativeSafeIntegerSchema,
  receiptStatus: returnCaseReceiptStatusSchema,
  unitPaidPriceCents: nonNegativeSafeIntegerSchema,
  sourceLineTotalCents: nonNegativeSafeIntegerSchema,
  createdAt: dateTimeSchema,
}).strict().superRefine((item, context) => {
  if (!Number.isSafeInteger(item.receivedQuantity + item.remainingQuantity)
    || item.expectedQuantity !== item.receivedQuantity + item.remainingQuantity) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Item receipt quantities are inconsistent.",
      path: ["expectedQuantity"],
    });
  }
  const expectedStatus = item.remainingQuantity === 0
    ? "received"
    : item.receivedQuantity > 0
      ? "partially_received"
      : "expected";
  if (item.receiptStatus !== expectedStatus) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "receiptStatus is inconsistent with the item receipt quantities.",
      path: ["receiptStatus"],
    });
  }
});

const returnCaseEventSchema = z.object({
  id: positiveSafeIntegerSchema,
  eventType: requiredTextSchema,
  actor: requiredTextSchema,
  details: jsonValueSchema,
  occurredAt: dateTimeSchema,
  createdAt: dateTimeSchema,
}).strict();

export const returnCaseDetailSchema = z.object({
  recordOrigin: z.enum(["canonical", "legacy_dropship"]),
  recordKey: requiredTextSchema,
  legacyRmaId: positiveSafeIntegerSchema.nullable(),
  id: positiveSafeIntegerSchema,
  caseNumber: requiredTextSchema,
  sourceProvider: requiredTextSchema,
  sourceEventType: requiredTextSchema,
  sourceEventId: requiredTextSchema,
  businessContext: requiredTextSchema,
  channelId: positiveSafeIntegerSchema.nullable(),
  channelName: nullableRequiredTextSchema,
  vendorId: positiveSafeIntegerSchema.nullable(),
  vendorName: nullableRequiredTextSchema,
  storeConnectionId: positiveSafeIntegerSchema.nullable(),
  storeName: nullableRequiredTextSchema,
  omsOrderId: positiveSafeIntegerSchema.nullable(),
  omsOrderNumber: nullableRequiredTextSchema,
  wmsOrderId: positiveSafeIntegerSchema.nullable(),
  wmsOrderNumber: nullableRequiredTextSchema,
  wmsReturnId: positiveSafeIntegerSchema.nullable(),
  caseStatus: requiredTextSchema,
  approvalStatus: requiredTextSchema,
  logisticsStatus: requiredTextSchema,
  inspectionStatus: requiredTextSchema,
  customerRefundStatus: requiredTextSchema,
  vendorSettlementStatus: requiredTextSchema,
  openedAt: dateTimeSchema,
  closedAt: dateTimeSchema.nullable(),
  itemCount: nonNegativeSafeIntegerSchema,
  unitCount: nonNegativeSafeIntegerSchema,
  policyId: positiveSafeIntegerSchema,
  policyVersion: positiveSafeIntegerSchema,
  policySnapshot: jsonValueSchema,
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
  items: z.array(returnCaseDetailItemSchema),
  events: z.array(returnCaseEventSchema),
  actionPlan: returnCaseActionPlanSchema,
}).strict().superRefine((detail, context) => {
  if (detail.itemCount !== detail.items.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "itemCount does not match the returned item lines.",
      path: ["itemCount"],
    });
  }
  const totals = detail.items.reduce(
    (result, item) => ({
      expected: result.expected + item.expectedQuantity,
      received: result.received + item.receivedQuantity,
      remaining: result.remaining + item.remainingQuantity,
    }),
    { expected: 0, received: 0, remaining: 0 },
  );
  if (!Object.values(totals).every(Number.isSafeInteger)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Item receipt totals exceed the safe integer range.",
      path: ["items"],
    });
    return;
  }
  const summary = detail.actionPlan.receiptSummary;
  if (totals.expected !== summary.expectedUnits
    || totals.received !== summary.receivedUnits
    || totals.remaining !== summary.remainingUnits) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "The action-plan receipt summary does not match the item lines.",
      path: ["actionPlan", "receiptSummary"],
    });
  }
});

const notesSchema = z.string().trim().max(MAX_NOTES_LENGTH).nullable().optional()
  .transform((value) => value || null);
const idempotencyKeySchema = z.string().trim().min(1).max(MAX_IDEMPOTENCY_KEY_LENGTH);
const receiptLineInputSchema = z.object({
  returnCaseItemId: positiveSafeIntegerSchema,
  expectedCurrentReceivedQuantity: nonNegativeSafeIntegerSchema,
  quantityReceivedNow: positiveSafeIntegerSchema,
}).strict();

export const recordReturnReceiptInputSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  lines: z.array(receiptLineInputSchema).min(1).max(MAX_RECEIPT_LINES),
  notes: notesSchema,
}).strict().superRefine((input, context) => {
  const seenIds = new Set<number>();
  for (const [index, line] of input.lines.entries()) {
    if (seenIds.has(line.returnCaseItemId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A return case item may only appear once.",
        path: ["lines", index, "returnCaseItemId"],
      });
    }
    seenIds.add(line.returnCaseItemId);
  }
});

export const startReturnInspectionInputSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  notes: notesSchema,
}).strict();

export const recordReturnReceiptResultSchema = z.object({
  commandType: z.literal("record_receipt"),
  caseId: positiveSafeIntegerSchema,
  caseNumber: requiredTextSchema,
  wmsReturnId: positiveSafeIntegerSchema,
  logisticsStatus: z.enum(["partially_received", "received"]),
  expectedUnits: positiveSafeIntegerSchema,
  receivedUnits: positiveSafeIntegerSchema,
  remainingUnits: nonNegativeSafeIntegerSchema,
  replayed: z.boolean(),
}).strict().superRefine((result, context) => {
  if (!Number.isSafeInteger(result.receivedUnits + result.remainingUnits)
    || result.expectedUnits !== result.receivedUnits + result.remainingUnits) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Receipt command totals are inconsistent.",
      path: ["expectedUnits"],
    });
  }
  const expectedStatus = result.remainingUnits === 0 ? "received" : "partially_received";
  if (result.logisticsStatus !== expectedStatus) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "logisticsStatus is inconsistent with the receipt command totals.",
      path: ["logisticsStatus"],
    });
  }
});

export const startReturnInspectionResultSchema = z.object({
  commandType: z.literal("start_inspection"),
  caseId: positiveSafeIntegerSchema,
  caseNumber: requiredTextSchema,
  inspectionId: positiveSafeIntegerSchema,
  inspectionStatus: z.literal("in_progress"),
  startedAt: dateTimeSchema,
  replayed: z.boolean(),
}).strict();

export type ReturnCaseActionKind = z.infer<typeof returnCaseActionKindSchema>;
export type ReturnCaseAction = z.infer<typeof returnCaseActionSchema>;
export type ReturnCaseActionPlan = z.infer<typeof returnCaseActionPlanSchema>;
export type ReturnCaseDetailItem = z.infer<typeof returnCaseDetailItemSchema>;
export type ReturnCaseDetail = z.infer<typeof returnCaseDetailSchema>;
export type RecordReturnReceiptInput = z.input<typeof recordReturnReceiptInputSchema>;
export type RecordReturnReceiptResult = z.infer<typeof recordReturnReceiptResultSchema>;
export type StartReturnInspectionInput = z.input<typeof startReturnInspectionInputSchema>;
export type StartReturnInspectionResult = z.infer<typeof startReturnInspectionResultSchema>;
export type ReturnCaseOperationResult = RecordReturnReceiptResult | StartReturnInspectionResult;

export type ReturnCaseAdminApiErrorCode =
  | "RETURN_CASE_CLIENT_INPUT_INVALID"
  | "RETURN_CASE_REQUEST_FAILED"
  | "RETURN_CASE_RESPONSE_INVALID";

export class ReturnCaseAdminApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(input: {
    code: string;
    message: string;
    status: number;
    context?: Readonly<Record<string, unknown>>;
  }) {
    super(input.message);
    this.name = "ReturnCaseAdminApiError";
    this.code = input.code;
    this.status = input.status;
    this.context = Object.freeze({ ...(input.context ?? {}) });
  }
}

export type ReturnCaseAdminTransport = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export async function getReturnCaseDetail(
  caseId: number,
  transport: ReturnCaseAdminTransport = fetch,
): Promise<ReturnCaseDetail> {
  const parsedCaseId = parseCaseId(caseId);
  return requestJson(
    `/api/returns/admin/cases/${parsedCaseId}`,
    { method: "GET", credentials: "include", headers: { Accept: "application/json" } },
    returnCaseDetailSchema,
    transport,
  );
}

export async function recordReturnReceipt(
  caseId: number,
  input: RecordReturnReceiptInput,
  transport: ReturnCaseAdminTransport = fetch,
): Promise<RecordReturnReceiptResult> {
  const parsedCaseId = parseCaseId(caseId);
  const parsedInput = parseOutboundInput(recordReturnReceiptInputSchema, input);
  const body = {
    ...parsedInput,
    lines: [...parsedInput.lines].sort(
      (left, right) => left.returnCaseItemId - right.returnCaseItemId,
    ),
  };
  return requestJson(
    `/api/returns/admin/cases/${parsedCaseId}/receipt`,
    jsonPost(body),
    recordReturnReceiptResultSchema,
    transport,
  );
}

export async function startReturnInspection(
  caseId: number,
  input: StartReturnInspectionInput,
  transport: ReturnCaseAdminTransport = fetch,
): Promise<StartReturnInspectionResult> {
  const parsedCaseId = parseCaseId(caseId);
  const parsedInput = parseOutboundInput(startReturnInspectionInputSchema, input);
  return requestJson(
    `/api/returns/admin/cases/${parsedCaseId}/inspections/start`,
    jsonPost(parsedInput),
    startReturnInspectionResultSchema,
    transport,
  );
}

export function createReturnCaseIdempotencyKey(command: ReturnCaseActionKind): string {
  if (!globalThis.crypto || typeof globalThis.crypto.randomUUID !== "function") {
    throw new ReturnCaseAdminApiError({
      code: "RETURN_CASE_CLIENT_INPUT_INVALID",
      message: "A secure idempotency key could not be generated.",
      status: 0,
      context: { field: "idempotencyKey" },
    });
  }
  return `returns-admin:${command}:${globalThis.crypto.randomUUID()}`;
}

function parseCaseId(caseId: number): number {
  const parsed = positiveSafeIntegerSchema.safeParse(caseId);
  if (!parsed.success) throw inputError(parsed.error);
  return parsed.data;
}

function parseOutboundInput<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  input: unknown,
): z.output<TSchema> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  return parsed.data;
}

function inputError(error: z.ZodError): ReturnCaseAdminApiError {
  return new ReturnCaseAdminApiError({
    code: "RETURN_CASE_CLIENT_INPUT_INVALID",
    message: "Return case operation input is invalid.",
    status: 0,
    context: { issues: mapIssues(error) },
  });
}

function jsonPost(body: unknown): RequestInit {
  return {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function requestJson<TSchema extends z.ZodTypeAny>(
  url: string,
  init: RequestInit,
  responseSchema: TSchema,
  transport: ReturnCaseAdminTransport,
): Promise<z.output<TSchema>> {
  let response: Response;
  try {
    response = await transport(url, init);
  } catch (cause) {
    throw new ReturnCaseAdminApiError({
      code: "RETURN_CASE_REQUEST_FAILED",
      message: "Return case request failed before a response was received.",
      status: 0,
      context: { causeName: cause instanceof Error ? cause.name : "UnknownError" },
    });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (!response.ok) {
      throw new ReturnCaseAdminApiError({
        code: "RETURN_CASE_REQUEST_FAILED",
        message: `Return case request failed (${response.status}).`,
        status: response.status,
      });
    }
    throw new ReturnCaseAdminApiError({
      code: "RETURN_CASE_RESPONSE_INVALID",
      message: "Return case request returned invalid JSON.",
      status: response.status,
    });
  }

  if (!response.ok) throw errorFromResponse(body, response.status);

  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) {
    throw new ReturnCaseAdminApiError({
      code: "RETURN_CASE_RESPONSE_INVALID",
      message: "Return case request returned an invalid response.",
      status: response.status,
      context: { issues: mapIssues(parsed.error) },
    });
  }
  return parsed.data;
}

const errorResponseSchema = z.object({
  error: z.object({
    code: z.string().trim().min(1).max(160),
    message: z.string().trim().min(1).max(2_000),
    context: z.record(jsonValueSchema).optional(),
  }).strict(),
}).strict();

function errorFromResponse(body: unknown, status: number): ReturnCaseAdminApiError {
  const parsed = errorResponseSchema.safeParse(body);
  if (!parsed.success) {
    return new ReturnCaseAdminApiError({
      code: "RETURN_CASE_REQUEST_FAILED",
      message: `Return case request failed (${status}).`,
      status,
    });
  }
  return new ReturnCaseAdminApiError({
    code: parsed.data.error.code,
    message: parsed.data.error.message,
    status,
    context: parsed.data.error.context,
  });
}

function mapIssues(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}
