import { useMemo } from "react";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { useAuth } from "./auth";
import { financialCommandFetchJson } from "./financial-command";

export type InventoryCommandRequester = <T = unknown>(url: string, body: Record<string, unknown>) => Promise<T>;
export interface InventoryIntentPersistence {
  /** The authenticated account, never a role or display name. */
  actorId: string;
  storage: () => Pick<Storage, "getItem" | "setItem">;
}
const pendingSchema = z.object({
  url: z.string().min(1), fingerprint: z.string(), commandKey: z.string().min(1).max(120), requestBody: z.string(),
}).strict();
const savedSchema = z.object({ version: z.literal(1), pending: z.array(pendingSchema) }).strict();
type PendingIntent = z.infer<typeof pendingSchema>;

export class InventoryIntentRecoveryError extends Error {
  readonly code = "INVENTORY_INTENT_RECOVERY_REQUIRED";
  constructor(cause: unknown) {
    super("Inventory retry information could not be safely read or saved. The earlier operation may already have completed. Restore this tab's session storage or ask an administrator to verify it before starting another.", { cause });
    this.name = "InventoryIntentRecoveryError";
  }
}

/** One client intent survives a lost response. A successful command or an edited
 * payload starts a new intent; retry never generates another quantity command.
 * Retain on every failure: older inventory handlers can report a generic HTTP
 * error after a committed mutation, so status alone is not rejection evidence.
 */
export function createInventoryCommandRequester(
  generateKey: () => string,
  send: typeof financialCommandFetchJson = financialCommandFetchJson,
  persistence?: InventoryIntentPersistence,
): InventoryCommandRequester {
  let inMemory: PendingIntent[] = [];
  const storageKey = `echelon:inventory-intents:v1:${persistence?.actorId ?? "test"}`;
  const read = (): PendingIntent[] => {
    if (!persistence) return inMemory;
    try {
      if (!persistence.actorId) throw new Error("An authenticated actor is required");
      const raw = persistence.storage().getItem(storageKey);
      if (raw === null) return [];
      const parsed = savedSchema.parse(JSON.parse(raw));
      const keys = new Set<string>();
      const intents = new Set<string>();
      for (const entry of parsed.pending) {
        const wire = JSON.parse(entry.requestBody) as Record<string, unknown>;
        const { commandKey, ...payload } = wire;
        const identity = canonicalJson([entry.url, entry.fingerprint]);
        if (commandKey !== entry.commandKey || canonicalJson(payload) !== entry.fingerprint
          || keys.has(entry.commandKey) || intents.has(identity)) {
          throw new Error("Retained inventory intent does not match its wire payload");
        }
        keys.add(entry.commandKey);
        intents.add(identity);
      }
      return parsed.pending;
    } catch (cause) { throw new InventoryIntentRecoveryError(cause); }
  };
  const write = (pending: PendingIntent[]): void => {
    if (!persistence) { inMemory = pending; return; }
    try { persistence.storage().setItem(storageKey, JSON.stringify({ version: 1, pending })); }
    catch (cause) { throw new InventoryIntentRecoveryError(cause); }
  };
  return async <T>(url: string, body: Record<string, unknown>): Promise<T> => {
    if (Object.prototype.hasOwnProperty.call(body, "commandKey")) throw new Error("The inventory intent owner supplies commandKey");
    // Fingerprint the actual wire payload, excluding omitted undefined fields.
    const payload = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
    const fingerprint = canonicalJson(payload);
    const pending = read();
    let intent = pending.find(entry => entry.url === url && entry.fingerprint === fingerprint);
    if (!intent) {
      const commandKey = z.string().min(1).max(120).parse(generateKey());
      if (pending.some(entry => entry.commandKey === commandKey)) throw new InventoryIntentRecoveryError(new Error("Duplicate generated command key"));
      intent = { url, fingerprint, commandKey, requestBody: JSON.stringify({ ...payload, commandKey }) };
      // Persist BEFORE I/O. Never evict another unresolved intent when the user
      // edits a form; returning to that intent must still find its original key.
      write([...pending, intent]);
    }
    const result = await send<T>(url, {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: intent.requestBody,
    });
    // Read again: another request may have retained its own intent while this
    // one was in flight. Remove only the acknowledged command, never its peers.
    write(read().filter(entry => entry.commandKey !== intent.commandKey));
    return result;
  };
}

export function useInventoryCommand(): InventoryCommandRequester {
  const { user } = useAuth();
  return useMemo(() => createInventoryCommandRequester(() => `inventory:${crypto.randomUUID()}`,
    financialCommandFetchJson, { actorId: user?.id ?? "", storage: () => window.sessionStorage }), [user?.id]);
}
