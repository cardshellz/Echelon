import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { shipmentCreateSchema, shipmentCreateResultSchema, type ShipmentCreateInput, type ShipmentCreateResult } from "@shared/procurement/shipment-create-command";
import { FinancialCommandRequestError, financialCommandFetchJson } from "./financial-command";
import { createPersistentFinancialIntentStore } from "./persistent-financial-intent";

const keySchema = z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/);
const recoverySchema = z.object({ version: z.literal(1), userId: z.string().min(1), key: keySchema, body: shipmentCreateSchema }).strict();
export type ShipmentCreateRecovery = z.infer<typeof recoverySchema>;
type RecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Both creation screens share one unresolved intent per authenticated browser session. */
export function createShipmentCreateRecoveryStore(storage: () => RecoveryStorage, userId: string) {
  if (!userId.trim()) throw new Error("Sign in before creating a shipment.");
  return createPersistentFinancialIntentStore<ShipmentCreateInput, ShipmentCreateRecovery>({
    storage, userId, storageKey: `echelon:shipment-create:v1:${encodeURIComponent(userId)}`,
    parse: (raw) => recoverySchema.parse(raw),
    messages: {
      read: "Shipment recovery cannot be read. Restore browser session storage before creating a shipment.",
      corrupt: "Saved shipment creation cannot be verified. Restore the original saved request before creating another shipment.",
      unresolved: "A shipment creation is unresolved. Recover its saved request before creating another shipment.",
      save: "Shipment creation was not sent because its recovery request could not be saved. Restore browser session storage and retry.",
      clear: "The shipment result was confirmed, but recovery could not be cleared. Recover the saved request again.",
    },
  });
}
export type ShipmentCreateRecoveryStore = ReturnType<typeof createShipmentCreateRecoveryStore>;

export function createShipmentCreateClient(generateKey: () => string, store: ShipmentCreateRecoveryStore) {
  return {
    async execute(input: ShipmentCreateInput, pinned?: ShipmentCreateRecovery): Promise<ShipmentCreateResult> {
      const body = shipmentCreateSchema.parse(input);
      if (pinned) {
        const original = recoverySchema.parse(pinned);
        if (original.userId !== store.userId || canonicalJson(original.body) !== canonicalJson(body)) throw new Error("The saved shipment request does not match this operator and intent.");
      }
      // Pin a visible recovery card even if an earlier response just cleared storage.
      const record = store.acquire(body, pinned ? () => pinned.key : generateKey);
      if (pinned && pinned.key !== record.key) throw new Error("A different shipment request now needs recovery. Reload before retrying.");
      try {
        const raw = await financialCommandFetchJson<unknown>("/api/inbound-shipments", {
          method: "POST", credentials: "include", headers: { "Content-Type": "application/json", "Idempotency-Key": record.key }, body: JSON.stringify(body),
        });
        const parsed = shipmentCreateResultSchema.safeParse(raw);
        if (!parsed.success || parsed.data.lineCount !== (body.purchaseOrder?.lineSelections?.length ?? 0)
          || parsed.data.createdBy !== store.userId
          || (body.shipmentNumber !== undefined && parsed.data.shipmentNumber !== body.shipmentNumber)) {
          throw new FinancialCommandRequestError("Shipment creation may have completed, but its result could not be verified. Recover the saved request.", {
            status: 201, code: "SHIPMENT_CREATE_RESPONSE_INVALID", retryable: true, ambiguous: true,
          });
        }
        store.complete(record.key);
        return parsed.data;
      } catch (error) {
        // A 401/403, proxy error, key mismatch, or unreadable result cannot prove
        // that an earlier attempt rolled back. Only this command's durable
        // rejection allows a new intent; all other failures retain exact evidence.
        if (error instanceof FinancialCommandRequestError && !error.ambiguous
          && error.details?.shipmentCreateOutcome === "rejected" && error.details.idempotencyKey === record.key) {
          store.complete(record.key);
        }
        throw error;
      }
    },
  };
}
