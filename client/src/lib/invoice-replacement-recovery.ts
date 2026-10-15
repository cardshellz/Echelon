import { z } from "zod";
import { invoiceReplacementInputSchema, type ReplacementInvoiceInput } from "@shared/procurement/invoice-replacement";
import { canonicalJson } from "@shared/utils/canonical-json";

const recoverySchema = z.object({
  version: z.literal(1), userId: z.string().min(1), invoiceId: z.number().int().positive().max(2_147_483_647),
  key: z.string().uuid(), body: invoiceReplacementInputSchema,
}).strict();
export type InvoiceReplacementIntent = z.infer<typeof recoverySchema>;
type RecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Preserve the exact request across navigation, reload, and an unknown commit outcome. */
export function createInvoiceReplacementRecovery(storage: () => RecoveryStorage, userId: string, invoiceId: number) {
  const storageKey = `echelon:invoice-replacement:v1:${encodeURIComponent(userId)}:${invoiceId}`;
  function read(): InvoiceReplacementIntent | null {
    try {
      const raw = storage().getItem(storageKey);
      if (raw === null) return null;
      const saved = recoverySchema.parse(JSON.parse(raw));
      if (saved.userId !== userId || saved.invoiceId !== invoiceId) throw new Error("Recovery identity mismatch");
      return saved;
    } catch {
      throw new Error("The saved replacement request could not be read. Restore this browser's session storage before sending another request.");
    }
  }
  return {
    read,
    acquire(body: ReplacementInvoiceInput, generateKey: () => string): InvoiceReplacementIntent {
      const existing = read();
      if (existing) {
        if (canonicalJson(existing.body) !== canonicalJson(body)) throw new Error("An earlier replacement is unresolved. Retry the saved request first.");
        return existing;
      }
      const intent = recoverySchema.parse({ version: 1, userId, invoiceId, key: generateKey(), body });
      try { storage().setItem(storageKey, JSON.stringify(intent)); }
      catch { throw new Error("The replacement was not sent because its recovery key could not be saved. Restore session storage and retry."); }
      return intent;
    },
    complete(key: string) {
      if (read()?.key !== key) return;
      try { storage().removeItem(storageKey); }
      catch { throw new Error("The replacement result was confirmed, but its saved request could not be cleared. Retry the saved request to confirm it safely."); }
    },
  };
}
