import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { receivingQuarantineViewSchema, type ReceivingQuarantineView } from "@shared/procurement/receiving-quarantine";
import { custodyActionSchema, custodyRequestSchemas, verifyCustodyCommandResult, type VerifiedCustodyResult } from "@shared/procurement/receiving-quarantine-command";
import { createPersistentFinancialIntentStore } from "./persistent-financial-intent";
import { FinancialCommandRequestError, financialCommandFetchJson } from "./financial-command";

const id = z.number().int().positive().max(2_147_483_647);
const commandSchema = z.object({ receiptId: id, observationId: id.nullable(), command: custodyActionSchema, payload: z.unknown() }).strict().superRefine((value, context) => {
  if ((value.command === "intake") !== (value.observationId === null) || !custodyRequestSchemas[value.command].safeParse(value.payload).success)
    context.addIssue({ code: "custom", message: "The saved quarantine action or input is invalid." });
});
const attemptSchema = z.object({ version: z.literal(1), userId: z.string().trim().min(1).max(100), key: z.string().uuid(), body: commandSchema }).strict();
export type ReceivingCustodyAttempt = z.infer<typeof attemptSchema>;
type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export class ReceivingCustodyRequestError extends Error {
  constructor(message: string, readonly outcomeUnknown: boolean) { super(message); }
}

/** Keep the old receipt storage key so unowned legacy attempts block dispatch.
 * We never assign the current operator to an older unidentified browser intent. */
export function createReceivingCustodyStore(receiptId: number, userId: string, storage: () => StoragePort = () => sessionStorage) {
  id.parse(receiptId);
  if (!userId.trim()) throw new Error("Sign in before recovering quarantine custody.");
  return createPersistentFinancialIntentStore<ReceivingCustodyAttempt["body"], ReceivingCustodyAttempt>({ storage,
    storageKey: `receiving-custody-command:${receiptId}`, userId,
    parse: raw => { const value = attemptSchema.parse(raw); if (value.body.receiptId !== receiptId) throw new Error("Receipt mismatch"); return value; },
    messages: {
      read: "Quarantine recovery cannot be read. Restore browser session storage before another custody change.",
      corrupt: "The saved quarantine request belongs to another operator or has legacy evidence without an operator. Sign in as the original operator; legacy evidence requires review before another custody change.",
      unresolved: "A quarantine command is unresolved. Recover its exact saved request before another change.",
      save: "The quarantine command was not sent because its recovery request could not be saved.",
      clear: "The quarantine outcome was verified, but recovery could not be cleared. Retry the saved command.",
    },
  });
}
export type ReceivingCustodyStore = ReturnType<typeof createReceivingCustodyStore>;
export function acquireReceivingCustodyAttempt(store: ReceivingCustodyStore, receiptId: number, observationId: number | null, path: string, payload: unknown): ReceivingCustodyAttempt {
  const command = observationId === null && path === `/api/receiving/${receiptId}/quarantine` ? "intake" : path.split("/").at(-1);
  const action = custodyActionSchema.parse(command);
  if (action !== "intake" && path !== `/api/receiving/quarantine/${observationId}/${action}`) throw new Error("The quarantine action does not match its target.");
  const body = commandSchema.parse({ receiptId, observationId, command: action, payload: custodyRequestSchemas[action].parse(payload) });
  return store.acquire(body, () => {
    if (!globalThis.crypto?.randomUUID) throw new Error("This browser cannot create a safe command identifier.");
    return crypto.randomUUID();
  });
}
export async function readReceivingQuarantine(receiptId: number, signal?: AbortSignal): Promise<ReceivingQuarantineView> {
  const raw = await financialCommandFetchJson<unknown>(`/api/receiving/${receiptId}/quarantine`, { credentials: "include", signal });
  const parsed = receivingQuarantineViewSchema.safeParse(raw);
  if (!parsed.success || parsed.data.receivingOrderId !== receiptId) throw new Error("The quarantine custody response was incomplete or belonged to another receipt. Load it again before continuing.");
  return parsed.data;
}
export async function executeReceivingCustodyAttempt(store: ReceivingCustodyStore, attempt: ReceivingCustodyAttempt): Promise<VerifiedCustodyResult> {
  const original = attemptSchema.parse(attempt);
  if (original.userId !== store.userId) throw new Error("Sign in as the original operator to recover this quarantine request.");
  const saved = store.read();
  if (!saved || canonicalJson(saved) !== canonicalJson(original)) throw new Error("The saved quarantine request changed. Reload before retrying.");
  const body = original.body;
  const identity = { command: body.command, resourceId: body.observationId ?? body.receiptId, actorId: original.userId, idempotencyKey: original.key };
  const path = body.command === "intake" ? `/api/receiving/${body.receiptId}/quarantine` : `/api/receiving/quarantine/${body.observationId}/${body.command}`;
  try {
    const raw = await financialCommandFetchJson<unknown>(path, { method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json", "Idempotency-Key": original.key }, body: JSON.stringify(body.payload) });
    let result: VerifiedCustodyResult;
    try {
      result = verifyCustodyCommandResult(raw, identity, body.payload);
      if (result.observation.receivingOrderId !== body.receiptId) throw new Error("Receipt mismatch");
    } catch { throw new ReceivingCustodyRequestError("The quarantine outcome could not be verified. Retry the same saved command before another change.", true); }
    store.complete(original.key);
    return result;
  } catch (error) {
    const rejected = error instanceof FinancialCommandRequestError && !error.ambiguous && error.status !== null && error.status >= 400 && error.status < 500
      && error.details?.custodyCommandOutcome === "rejected"
      && Object.entries(identity).every(([key, value]) => error.details?.[key] === value);
    if (rejected) store.complete(original.key);
    throw error instanceof ReceivingCustodyRequestError ? error : new ReceivingCustodyRequestError(error instanceof Error ? error.message : "The quarantine outcome is unknown.", !rejected);
  }
}
