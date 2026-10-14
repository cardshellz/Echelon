import { z } from "zod";
import {
  cancelQuarantineAcceptanceSchema, prepareQuarantineAcceptanceSchema,
  receivingQuarantineCommandResultSchema, receivingQuarantineIntakeSchema,
  receivingQuarantineViewSchema, returnQuarantineCustodySchema,
  type ReceivingQuarantineCommandResult, type ReceivingQuarantineView,
} from "@shared/procurement/receiving-quarantine";

export interface ReceivingCustodyAttempt {
  receiptId: number;
  observationId: number | null;
  path: string;
  key: string;
  body: unknown;
}

export class ReceivingCustodyRequestError extends Error {
  constructor(message: string, readonly outcomeUnknown: boolean) { super(message); }
}

const attemptSchema = z.object({
  receiptId: z.number().int().positive(), observationId: z.number().int().positive().nullable(),
  path: z.string(), key: z.string().uuid(), body: z.unknown(),
}).strict();
const storageKey = (receiptId: number) => `receiving-custody-command:${receiptId}`;

function validateAttempt(value: unknown, receiptId: number): ReceivingCustodyAttempt {
  const attempt = attemptSchema.parse(value);
  if (attempt.receiptId !== receiptId) throw new Error("The saved quarantine command belongs to another receipt.");
  const suffix = attempt.path.split("/").at(-1);
  const schema = attempt.observationId === null && attempt.path === `/api/receiving/${receiptId}/quarantine`
    ? receivingQuarantineIntakeSchema
    : attempt.observationId !== null && attempt.path === `/api/receiving/quarantine/${attempt.observationId}/${suffix}`
      ? suffix === "prepare-acceptance" ? prepareQuarantineAcceptanceSchema
        : suffix === "return" ? returnQuarantineCustodySchema
          : suffix === "cancel-acceptance" ? cancelQuarantineAcceptanceSchema : null
      : null;
  if (!schema) throw new Error("The saved quarantine command has an unsupported action.");
  return { ...attempt, body: schema.parse(attempt.body) };
}

/** Retain the exact reviewed intent across navigation and an ambiguous response.
 * Never replace its key until its result is confirmed or a rejected command has
 * been read back. Storage is validated as untrusted input when restored. */
export function readReceivingCustodyAttempt(receiptId: number): ReceivingCustodyAttempt | null {
  const saved = sessionStorage.getItem(storageKey(receiptId));
  return saved === null ? null : validateAttempt(JSON.parse(saved), receiptId);
}

export function saveReceivingCustodyAttempt(attempt: ReceivingCustodyAttempt): void {
  const validated = validateAttempt(attempt, attempt.receiptId);
  sessionStorage.setItem(storageKey(attempt.receiptId), JSON.stringify(validated));
}

export function clearReceivingCustodyAttempt(receiptId: number): void {
  sessionStorage.removeItem(storageKey(receiptId));
}

export function createReceivingCustodyAttempt(
  receiptId: number, observationId: number | null, path: string, body: unknown,
): ReceivingCustodyAttempt {
  if (!globalThis.crypto?.randomUUID) throw new Error("This browser cannot create a safe command identifier. Reload using a supported secure connection.");
  return validateAttempt({ receiptId, observationId, path, body, key: crypto.randomUUID() }, receiptId);
}

async function responseBody(response: Response): Promise<unknown> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = z.object({ error: z.string().optional(), code: z.string().optional() }).passthrough().safeParse(body);
    const unresolved = response.status >= 500 || [408, 429].includes(response.status) ||
      error.success && error.data.code === "FINANCIAL_COMMAND_IN_PROGRESS";
    throw new ReceivingCustodyRequestError(error.success && error.data.error
      ? error.data.error : `The quarantine request failed (HTTP ${response.status}).`, unresolved);
  }
  return body;
}

export async function readReceivingQuarantine(receiptId: number, signal?: AbortSignal): Promise<ReceivingQuarantineView> {
  const response = await fetch(`/api/receiving/${receiptId}/quarantine`, { credentials: "include", signal });
  const parsed = receivingQuarantineViewSchema.safeParse(await responseBody(response));
  if (!parsed.success || parsed.data.receivingOrderId !== receiptId) {
    throw new Error("The quarantine custody response was incomplete or belonged to another receipt. Load it again before continuing.");
  }
  return parsed.data;
}

export async function executeReceivingCustodyAttempt(attempt: ReceivingCustodyAttempt): Promise<ReceivingQuarantineCommandResult> {
  const reviewed = validateAttempt(attempt, attempt.receiptId);
  let response: Response;
  try {
    response = await fetch(reviewed.path, { method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json", "Idempotency-Key": reviewed.key }, body: JSON.stringify(reviewed.body) });
  } catch {
    throw new ReceivingCustodyRequestError("The quarantine outcome could not be confirmed. Retry this same command to recover its result.", true);
  }
  const parsed = receivingQuarantineCommandResultSchema.safeParse(await responseBody(response));
  if (!parsed.success || parsed.data.observation.receivingOrderId !== attempt.receiptId ||
      attempt.observationId !== null && parsed.data.observation.id !== attempt.observationId ||
      attempt.path.endsWith("prepare-acceptance") && parsed.success && parsed.data.acceptance === null) {
    throw new ReceivingCustodyRequestError("The quarantine outcome could not be verified. Retry this same command before recording another change.", true);
  }
  return parsed.data;
}
