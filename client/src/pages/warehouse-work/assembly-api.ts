import { z } from "zod";

export class AssemblyRequestError extends Error {
  constructor(message: string, readonly uncertain: boolean, readonly code: string) { super(message); }
}
export async function assemblyRequest<T>(url: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
  let response: Response;
  try { response = await fetch(url, { method: body === undefined ? "GET" : "POST", credentials: "include",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch { throw new AssemblyRequestError("No server receipt. Retry the same request; do not repeat physical work.", body !== undefined, "NETWORK_UNCERTAIN"); }
  let value: unknown;
  try { value = await response.json(); }
  catch { throw new AssemblyRequestError("The server receipt could not be read. Refresh/retry; do not repeat physical work.", body !== undefined, "RECEIPT_UNREADABLE"); }
  if (!response.ok) {
    const error = z.object({ message: z.string(), code: z.string().optional() }).safeParse(value);
    throw new AssemblyRequestError(error.success ? error.data.message : `Assembly request failed (${response.status})`, response.status >= 500, error.success ? error.data.code ?? "WORK_REQUEST_FAILED" : "WORK_REQUEST_FAILED");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AssemblyRequestError("The server returned an invalid work receipt; reload before continuing.", body !== undefined, "RECEIPT_INVALID");
  return parsed.data;
}
export interface AssemblyAttempt { url: string; fingerprint: string; body: Record<string, unknown> }
export function prepareAssemblyAttempt(url: string, payload: Record<string, unknown>, previous: AssemblyAttempt | null, createId: () => string): AssemblyAttempt {
  const fingerprint = JSON.stringify({ url, payload });
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw new AssemblyRequestError("Resolve the previous uncertain request before sending another action.", true, "WORK_RETRY_ORIGINAL_REQUEST");
    return previous;
  }
  return { url, fingerprint, body: { ...payload, commandId: createId() } };
}
