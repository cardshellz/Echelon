import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { shipmentCostCreateSchema, type ShipmentCostCreateCommand } from "@shared/procurement/shipment-cost-command";

const recoverySchema = z.object({
  schemaVersion: z.literal(1),
  userId: z.string().min(1),
  shipmentId: z.number().int().positive().safe(),
  key: z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/),
  body: shipmentCostCreateSchema,
}).strict();

export type ShipmentCostCreateRecovery = z.infer<typeof recoverySchema>;
type SessionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Persist before dispatch; recovery is scoped to the authenticated user and shipment. */
export function createShipmentCostRecoveryStore(storage: () => SessionStorage, userId: string) {
  if (!userId.trim()) throw new Error("Sign in before creating a shipment cost.");
  const storageKey = (shipmentId: number) => `echelon:shipment-cost-create:v1:${encodeURIComponent(userId)}:${shipmentId}`;
  function read(shipmentId: number): ShipmentCostCreateRecovery | null {
    let raw: string | null;
    try {
      raw = storage().getItem(storageKey(shipmentId));
    } catch {
      throw new Error("Saved cost commands cannot be read in this browser. Restore session storage before creating a cost.");
    }
    if (!raw) return null;
    try {
      const record = recoverySchema.parse(JSON.parse(raw));
      if (record.userId !== userId || record.shipmentId !== shipmentId) throw new Error("Recovery identity mismatch");
      return record;
    } catch {
      throw new Error("A saved cost command could not be verified. Review the shipment and recover that command before creating another cost.");
    }
  }
  return {
    read,
    acquire(shipmentId: number, body: ShipmentCostCreateCommand, generateKey: () => string): ShipmentCostCreateRecovery {
      const existing = read(shipmentId);
      if (existing) {
        if (canonicalJson(existing.body) !== canonicalJson(body)) {
          throw new Error("An earlier cost creation is unresolved. Retry its original command before creating a different cost.");
        }
        return existing;
      }
      const record = recoverySchema.parse({ schemaVersion: 1, userId, shipmentId, key: generateKey(), body });
      try {
        storage().setItem(storageKey(shipmentId), JSON.stringify(record));
      } catch {
        throw new Error("The cost was not sent because its recovery key could not be saved. Restore session storage and try again.");
      }
      return record;
    },
    complete(shipmentId: number, key: string): void {
      if (read(shipmentId)?.key !== key) return;
      try {
        storage().removeItem(storageKey(shipmentId));
      } catch {
        throw new Error("The cost command finished, but its recovery key could not be cleared. Retry the original command to confirm and clear it safely.");
      }
    },
  };
}

export type ShipmentCostRecoveryStore = ReturnType<typeof createShipmentCostRecoveryStore>;
