import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { shipmentCreateFromPoSchema, verifyShipmentCreatedFromPo, type ShipmentCreateFromPo, type ShipmentCreatedFromPo } from "@shared/procurement/shipment-create-from-po";
import { shipmentLineResourceIdSchema } from "@shared/procurement/shipment-line-command";
import { FinancialCommandRequestError, financialCommandFetchJson } from "./financial-command";

const recoverySchema = z.object({ userId: z.string().min(1), key: z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/),
  input: shipmentCreateFromPoSchema }).strict();
export type ShipmentCreateRecovery = z.infer<typeof recoverySchema>;
type SessionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** One unresolved creation per user/PO. Save the full request before sending;
 * a changed form must never turn an uncertain retry into a second shipment. */
export function createPoShipmentClient(userId: string, storage: () => SessionStorage, generateKey: () => string) {
  if (!userId.trim()) throw new Error("Sign in before creating a shipment.");
  const storageKey = (poId: number) => `echelon:po-shipment:v1:${encodeURIComponent(userId)}:${shipmentLineResourceIdSchema.parse(poId)}`;
  function read(poId: number): ShipmentCreateRecovery | null {
    let raw: string | null;
    try { raw = storage().getItem(storageKey(poId)); }
    catch { throw new Error("Saved shipment requests cannot be read. Restore browser session storage before creating another shipment."); }
    if (raw === null) return null;
    try {
      const saved = recoverySchema.parse(JSON.parse(raw));
      if (saved.userId !== userId || saved.input.source.purchaseOrderId !== poId) throw new Error("Identity mismatch");
      return saved;
    } catch { throw new Error("The saved shipment request cannot be verified. Recover the original request before creating another shipment."); }
  }
  function complete(poId: number, key: string) {
    try {
      if (read(poId)?.key === key) storage().removeItem(storageKey(poId));
    } catch (cause) {
      throw new FinancialCommandRequestError("The saved shipment request could not be cleared. Retry the original request to confirm its result.",
        { status: null, retryable: true, ambiguous: true, code: "SHIPMENT_CREATE_STORAGE_FAILED", cause });
    }
  }
  return {
    read,
    async execute(raw: ShipmentCreateFromPo, pinned?: ShipmentCreateRecovery): Promise<ShipmentCreatedFromPo> {
      const input = shipmentCreateFromPoSchema.parse(raw);
      const poId = input.source.purchaseOrderId;
      const previous = read(poId);
      const selected = pinned ? recoverySchema.parse(pinned) : previous;
      if (selected && (selected.userId !== userId || canonicalJson(selected.input) !== canonicalJson(input))) {
        throw new Error("An earlier shipment request is unresolved. Retry its original details before creating another shipment.");
      }
      if (previous && selected && previous.key !== selected.key) throw new Error("A different shipment request requires recovery. Reload this purchase order.");
      // Pin a displayed recovery card's key even if a delayed successful response
      // has since cleared storage. Retrying that card must still replay.
      const saved = selected ?? recoverySchema.parse({ userId, key: generateKey(), input });
      try { storage().setItem(storageKey(poId), JSON.stringify(saved)); }
      catch { throw new Error("Shipment creation was not sent because its recovery request could not be saved. Restore browser session storage and retry."); }
      try {
        const rawResult = await financialCommandFetchJson<unknown>("/api/inbound-shipments/from-po", {
          method: "POST", credentials: "include", headers: { "Content-Type": "application/json", "Idempotency-Key": saved.key }, body: JSON.stringify(input),
        });
        let result: ShipmentCreatedFromPo;
        try { result = verifyShipmentCreatedFromPo(input, rawResult); }
        catch (cause) { throw new FinancialCommandRequestError("The shipment may have been created, but its result could not be verified. Retry the saved request.",
          { status: 201, code: "SHIPMENT_CREATE_RESPONSE_INVALID", retryable: true, ambiguous: true, cause }); }
        complete(poId, saved.key);
        return result;
      } catch (error) {
        const recordedRejection = error instanceof FinancialCommandRequestError && !error.ambiguous
          && z.object({ commandStatus: z.literal("rejected") }).safeParse(error.responseBody).success;
        if (recordedRejection) complete(poId, saved.key);
        else if (error instanceof FinancialCommandRequestError && !error.ambiguous) {
          // A 401/403, key mismatch or proxy rejection says nothing about an
          // earlier attempt that may already have committed. Preserve its key.
          throw new FinancialCommandRequestError(error.message + " The saved shipment request is retained; retry it after resolving this error.",
            { status: error.status, code: error.code, responseBody: error.responseBody, details: error.details,
              retryable: error.retryable, ambiguous: true, retryAfterMs: error.retryAfterMs, cause: error });
        }
        throw error;
      }
    },
  };
}
