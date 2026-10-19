import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { expectedShipmentInvoiceTotal, createShipmentInvoiceCommandSchema, shipmentInvoiceCommandResponseSchema, shipmentInvoiceCommandRejectionSchema, type CreateShipmentInvoiceCommandInput } from "@shared/procurement/shipment-invoice-command";
import { financialCommandFetchJson, FinancialCommandRequestError } from "./financial-command";
import { createPersistentFinancialIntentStore } from "./persistent-financial-intent";

const commandSchema = z.object({ shipmentId: z.number().int().positive().max(2_147_483_647), payload: createShipmentInvoiceCommandSchema }).strict();
const recoverySchema = z.object({ version: z.literal(1), userId: z.string().min(1), key: z.string().regex(/^[A-Za-z0-9:_-]{8,100}$/), body: commandSchema }).strict();
export type ShipmentInvoiceRecovery = z.infer<typeof recoverySchema>;
type RecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export function createShipmentInvoiceRecoveryStore(storage: () => RecoveryStorage, userId: string, shipmentId: number) {
  if (!userId.trim() || !z.number().int().positive().max(2_147_483_647).safeParse(shipmentId).success) throw new Error("Sign in and select a valid shipment before creating an invoice.");
  return createPersistentFinancialIntentStore<z.infer<typeof commandSchema>, ShipmentInvoiceRecovery>({
    storage, userId, storageKey: `echelon:shipment-invoice:v1:${encodeURIComponent(userId)}:${shipmentId}`,
    parse: raw => {
      const record = recoverySchema.parse(raw);
      if (record.body.shipmentId !== shipmentId) throw new Error("Saved invoice belongs to another shipment.");
      return record;
    },
    messages: {
      read: "Invoice recovery cannot be read. Restore browser session storage before creating a shipment invoice.",
      corrupt: "Saved shipment invoice cannot be verified. Restore the original request before creating another invoice.",
      unresolved: "A shipment invoice request is unresolved. Recover the saved request before creating another invoice.",
      save: "The invoice was not sent because its recovery request could not be saved. Restore browser session storage and retry.",
      clear: "The invoice result was confirmed, but recovery could not be cleared. Recover the saved request again.",
    },
  });
}
export function createShipmentInvoiceClient(generateKey: () => string, store: ReturnType<typeof createShipmentInvoiceRecoveryStore>, shipmentId: number) {
  return { async execute(payload: CreateShipmentInvoiceCommandInput, pinned?: ShipmentInvoiceRecovery) {
    const body = commandSchema.parse({ shipmentId, payload });
    if (pinned) {
      const original = recoverySchema.parse(pinned);
      if (original.userId !== store.userId || canonicalJson(original.body) !== canonicalJson(body)) throw new Error("The saved invoice does not match this operator and shipment request.");
    }
    const record = store.acquire(body, pinned ? () => pinned.key : generateKey);
    if (pinned && pinned.key !== record.key) throw new Error("A different shipment invoice now needs recovery. Reload before retrying.");
    try {
      const raw = await financialCommandFetchJson<unknown>(`/api/inbound-shipments/${shipmentId}/create-invoice`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json", "Idempotency-Key": record.key }, body: JSON.stringify(body.payload),
      });
      const parsed = shipmentInvoiceCommandResponseSchema.safeParse(raw);
      const expectedTotal = expectedShipmentInvoiceTotal(body.payload);
      if (!parsed.success || parsed.data.shipmentId !== shipmentId || parsed.data.vendorId !== body.payload.vendorId
        || parsed.data.actorId !== store.userId || parsed.data.idempotencyKey !== record.key || parsed.data.invoiceNumber !== body.payload.invoiceNumber || expectedTotal !== null && BigInt(parsed.data.totalCents) !== expectedTotal
        || canonicalJson([...parsed.data.costRowIds].sort((a,b) => a-b)) !== canonicalJson([...body.payload.costRowIds].sort((a,b) => a-b))) {
        throw new FinancialCommandRequestError("The shipment invoice may have been created, but its result could not be verified. Recover the saved request.", {
          status: 200, code: "SHIPMENT_INVOICE_RESPONSE_INVALID", retryable: true, ambiguous: true,
        });
      }
      store.complete(record.key);
      return parsed.data;
    } catch (error) {
      if (error instanceof FinancialCommandRequestError && !error.ambiguous) {
        const rejected = shipmentInvoiceCommandRejectionSchema.safeParse(error.responseBody);
        if (rejected.success && rejected.data.idempotencyKey === record.key && rejected.data.shipmentId === shipmentId && rejected.data.actorId === store.userId) store.complete(record.key);
      }
      throw error;
    }
  } };
}

/** Parse cents without rounding, silent stripping or floating point. */
export function parseShipmentInvoiceAmount(raw: string): number {
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(raw.trim())) throw new Error("Enter an amount with at most two decimal places.");
  const value = raw.trim(); const negative = value.startsWith("-");
  const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  const cents = (BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, "0"))) * (negative ? -BigInt(1) : BigInt(1));
  if (cents < BigInt(Number.MIN_SAFE_INTEGER) || cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("The invoice amount exceeds the supported range.");
  return Number(cents);
}
export function shipmentInvoiceAmountInput(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new Error("The recorded invoice amount is invalid.");
  const absolute = BigInt(cents) < BigInt(0) ? -BigInt(cents) : BigInt(cents);
  return `${cents < 0 ? "-" : ""}${absolute / BigInt(100)}.${String(absolute % BigInt(100)).padStart(2, "0")}`;
}
