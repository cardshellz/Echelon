import { z } from "zod";
import type { ShipmentCostRecoveryStore } from "./shipment-cost-create-recovery";
import {
  shipmentCostCreateSchema,
  shipmentCostPatchSchema,
  shipmentCostDeleteSchema,
  shipmentCostVersionSchema,
} from "@shared/procurement/shipment-cost-command";
import {
  createFinancialCommandIntentStore,
  financialCommandFetchJson,
  FinancialCommandRequestError,
  type FinancialCommandIntentStore,
} from "./financial-command";

const versionSchema = shipmentCostVersionSchema;
const idSchema = z.number().int().positive().safe();
const recordedCostSchema = z.object({
  id: idSchema,
  inboundShipmentId: idSchema,
  version: versionSchema,
  costType: z.string(),
  description: z.string().nullable(),
  estimatedCents: z.number().int().safe().nullable(),
  actualCents: z.number().int().safe().nullable(),
  allocationMethod: z.string().nullable(),
  vendorId: idSchema.nullable(),
  vendorName: z.string().nullable().optional(),
  performedByName: z.string().nullable(),
  invoiceDate: z.string().nullable(),
  vendorInvoiceId: idSchema.nullable(),
  hasInvoiceSourceReference: z.boolean(),
  currency: z.string().nullable(),
  exchangeRate: z.string().nullable(),
});

export type ShipmentCostRecord = z.infer<typeof recordedCostSchema>;
export type ShipmentCostForm = {
  costType: string;
  description: string;
  amount: string;
  allocationMethod: string;
  vendorName: string;
  vendorId: number | null;
  performedByName: string;
  costDate: string;
};
export type ShipmentCostEditor = ShipmentCostForm & {
  id: number;
  inboundShipmentId: number;
  version: string;
  economicFieldsLocked: boolean;
  original: Readonly<Pick<ShipmentCostForm, "costType" | "amount" | "allocationMethod" | "vendorId" | "costDate">>;
};

export function isInvoiceOwnedShipmentCost(cost: {
  vendorInvoiceId?: unknown;
  hasInvoiceSourceReference?: unknown;
}): boolean {
  return cost.vendorInvoiceId != null || cost.hasInvoiceSourceReference === true;
}

export function canEditShipmentCostEconomics(cost: {
  vendorInvoiceId?: unknown;
  hasInvoiceSourceReference?: unknown;
  currency?: unknown;
  exchangeRate?: unknown;
}): boolean {
  return !isInvoiceOwnedShipmentCost(cost) && cost.currency === "USD"
    && typeof cost.exchangeRate === "string" && /^1(?:\.0+)?$/.test(cost.exchangeRate);
}

export function effectiveShipmentCostCents(cost: { actualCents?: number | null; estimatedCents?: number | null }): number | null {
  return cost.actualCents ?? cost.estimatedCents ?? null;
}

function centsAsInput(cents: number | null): string {
  if (cents === null) return "";
  const amount = BigInt(cents);
  const absolute = amount < BigInt(0) ? -amount : amount;
  return `${amount < BigInt(0) ? "-" : ""}${absolute / BigInt(100)}.${String(absolute % BigInt(100)).padStart(2, "0")}`;
}

/** Capture the exact version the operator saw; never silently rebase a draft. */
export function shipmentCostEditorFromRecord(input: unknown, expectedShipmentId?: number): ShipmentCostEditor {
  const result = recordedCostSchema.safeParse(input);
  if (!result.success) throw new Error("Cost details are incomplete. Refresh the shipment before editing this cost.");
  const cost = result.data;
  if (expectedShipmentId !== undefined && cost.inboundShipmentId !== expectedShipmentId) throw new Error("The cost belongs to a different shipment. Refresh and try again.");
  let costDate = "";
  if (cost.invoiceDate) {
    const date = new Date(cost.invoiceDate);
    if (!Number.isFinite(date.getTime())) throw new Error("The recorded cost date is invalid. Review the source cost before editing.");
    costDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }
  return {
    id: cost.id,
    inboundShipmentId: cost.inboundShipmentId,
    version: cost.version,
    costType: cost.costType,
    description: cost.description ?? "",
    amount: centsAsInput(effectiveShipmentCostCents(cost)),
    allocationMethod: cost.allocationMethod ?? "default",
    vendorId: cost.vendorId,
    vendorName: cost.vendorName ?? "",
    performedByName: cost.performedByName ?? "",
    costDate,
    // A non-USD row remains readable and can receive metadata corrections.
    economicFieldsLocked: !canEditShipmentCostEconomics(cost),
    original: {
      costType: cost.costType, amount: centsAsInput(effectiveShipmentCostCents(cost)),
      allocationMethod: cost.allocationMethod ?? "default", vendorId: cost.vendorId, costDate,
    },
  };
}

function parseChargeCents(raw: string): number {
  const value = raw.trim();
  if (!/^-?(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(value)) {
    throw new Error("Enter a USD amount with at most two decimal places. Use a negative amount for a credit.");
  }
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = value.replace(/^-/, "").split(".");
  const cents = BigInt(whole || "0") * BigInt(100) + BigInt(fraction.padEnd(2, "0"));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("The cost amount exceeds the supported limit.");
  return Number(negative ? -cents : cents);
}

function parseCostDate(value: string): string | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Enter a valid cost date.");
  const date = new Date(`${value}T00:00:00`);
  const [year, month, day] = value.split("-").map(Number);
  if (!Number.isFinite(date.getTime()) || date.getFullYear() !== year || date.getMonth() + 1 !== month || date.getDate() !== day) {
    throw new Error("Enter a valid cost date.");
  }
  return date.toISOString();
}

function economicPayload(form: ShipmentCostForm) {
  const costType = form.costType.trim();
  const allocationMethod = form.allocationMethod === "default"
    ? null : form.allocationMethod;
  const cents = parseChargeCents(form.amount);
  return {
    costType,
    description: form.description,
    vendorId: idSchema.nullable().parse(form.vendorId),
    performedByName: form.performedByName,
    estimatedCents: cents,
    actualCents: cents,
    allocationMethod,
    invoiceDate: parseCostDate(form.costDate),
  };
}

export function createShipmentCostPayload(form: ShipmentCostForm) {
  return shipmentCostCreateSchema.parse({ ...economicPayload(form), reason: "Added shipment charge from shipment detail" });
}

export function shipmentCostFormFromCreate(body: ReturnType<typeof createShipmentCostPayload>): ShipmentCostForm {
  const date = body.invoiceDate ? new Date(body.invoiceDate) : null;
  return {
    costType: body.costType, description: body.description ?? "",
    amount: centsAsInput(body.actualCents ?? body.estimatedCents ?? null),
    allocationMethod: body.allocationMethod ?? "default", vendorId: body.vendorId ?? null,
    vendorName: "", performedByName: body.performedByName ?? "",
    costDate: date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}` : "",
  };
}

export function updateShipmentCostPayload(editor: ShipmentCostEditor) {
  const changes: Record<string, unknown> = {
    description: editor.description,
    performedByName: editor.performedByName,
    expectedVersion: editor.version,
    reason: "Updated shipment cost from shipment detail",
  };
  if (!editor.economicFieldsLocked) {
    if (editor.costType !== editor.original.costType) changes.costType = editor.costType;
    if (editor.vendorId !== editor.original.vendorId) changes.vendorId = editor.vendorId;
    if (editor.allocationMethod !== editor.original.allocationMethod) {
      changes.allocationMethod = editor.allocationMethod === "default" ? null : editor.allocationMethod;
    }
    if (editor.costDate !== editor.original.costDate) changes.invoiceDate = parseCostDate(editor.costDate);
    if (editor.amount !== editor.original.amount) {
      changes.estimatedCents = parseChargeCents(editor.amount);
      changes.actualCents = changes.estimatedCents;
    }
  }
  // Omitting unchanged fields preserves separate estimates/actuals, source timestamps,
  // and legacy category values during metadata-only corrections.
  return shipmentCostPatchSchema.parse(changes);
}

export function deleteShipmentCostPayload(input: unknown, expectedShipmentId?: number) {
  const cost = recordedCostSchema.parse(input);
  if (expectedShipmentId !== undefined && cost.inboundShipmentId !== expectedShipmentId) throw new Error("The cost belongs to a different shipment. Refresh and try again.");
  if (!canEditShipmentCostEconomics(cost)) {
    throw new Error("This cost cannot be removed here. Review its invoice or currency source record.");
  }
  return shipmentCostDeleteSchema.parse({ expectedVersion: cost.version, reason: "Removed shipment charge from shipment detail" });
}

type CostCommand = {
  method: "POST" | "PATCH" | "DELETE";
  shipmentId: number;
  costId?: number;
  body: ReturnType<typeof createShipmentCostPayload> | ReturnType<typeof updateShipmentCostPayload> | ReturnType<typeof deleteShipmentCostPayload>;
};

/** Explicitly stateful: independent target records retain their own uncertain intent. */
export function createShipmentCostCommandClient(generateKey: () => string, createRecovery?: ShipmentCostRecoveryStore) {
  const intents = new Map<string, FinancialCommandIntentStore>();
  return {
    async execute(command: CostCommand): Promise<void> {
      const shipmentId = idSchema.parse(command.shipmentId);
      const body = command.method === "POST" ? shipmentCostCreateSchema.parse(command.body)
        : command.method === "PATCH" ? shipmentCostPatchSchema.parse(command.body)
        : shipmentCostDeleteSchema.parse(command.body);
      const costId = command.method === "POST" ? undefined : idSchema.parse(command.costId);
      const url = command.method === "POST"
        ? `/api/inbound-shipments/${shipmentId}/costs`
        : `/api/inbound-shipments/costs/${costId}`;
      const identity = `${command.method}:${url}`;
      let intent = intents.get(identity);
      if (!intent) {
        intent = createFinancialCommandIntentStore(generateKey);
        intents.set(identity, intent);
      }
      const recovery = command.method === "POST"
        ? createRecovery?.acquire(shipmentId, shipmentCostCreateSchema.parse(body), generateKey) : undefined;
      const key = recovery?.key ?? intent.acquire({ method: command.method, url, body });
      try {
        const result = await financialCommandFetchJson<unknown>(url, {
          method: command.method,
          credentials: "include",
          headers: { "Content-Type": "application/json", "Idempotency-Key": key },
          body: JSON.stringify(body),
        });
        let responseMatchesCommand: boolean;
        if (command.method === "DELETE") {
          responseMatchesCommand = z.object({ success: z.literal(true) }).safeParse(result).success;
        } else {
          const saved = z.object({ id: idSchema, inboundShipmentId: idSchema, version: versionSchema }).safeParse(result);
          responseMatchesCommand = saved.success && saved.data.inboundShipmentId === shipmentId
            && (costId === undefined || saved.data.id === costId);
        }
        if (!responseMatchesCommand) {
          throw new FinancialCommandRequestError("The cost may have been saved, but its response could not be verified. Retry will reuse the same command key.", {
            status: 200, code: "SHIPMENT_COST_RESPONSE_INVALID", retryable: true, ambiguous: true,
          });
        }
        if (recovery) {
          try { createRecovery!.complete(shipmentId, key); }
          catch (cause) {
            throw new FinancialCommandRequestError(cause instanceof Error ? cause.message : "The saved cost recovery key could not be cleared.", {
              status: 200, code: "SHIPMENT_COST_RECOVERY_STORAGE_FAILED", retryable: true, ambiguous: true, cause,
            });
          }
        }
        intent.complete(key);
      } catch (error) {
        intent.fail(key, error);
        if (recovery && !(error instanceof FinancialCommandRequestError && error.ambiguous)) {
          try { createRecovery!.complete(shipmentId, key); }
          catch (cause) {
            throw new FinancialCommandRequestError(cause instanceof Error ? cause.message : "The rejected cost recovery key could not be cleared.", {
              status: null, code: "SHIPMENT_COST_RECOVERY_STORAGE_FAILED", retryable: true, ambiguous: true, cause,
            });
          }
        }
        throw error;
      }
    },
  };
}

export function shipmentCostNeedsRefresh(error: unknown): boolean {
  return error instanceof FinancialCommandRequestError
    && !error.ambiguous && (error.status === 409 || error.status === 404);
}
