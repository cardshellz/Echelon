import type { z } from "zod";
export class ShipmentReadError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}
/** Only safe read-only shipment endpoints use this transport. Provider/DB response
 * diagnostics never become customer/staff wording. Invalid contracts fail closed.
 */
export async function readShipmentResource<T>(url: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url,{ credentials: "include",signal });
  if (!response.ok) throw new ShipmentReadError(response.status === 403
    ? "Your shipment access changed. Refresh access before continuing."
    : response.status === 404 ? "This shipment is no longer available." : "Shipment data could not be loaded.",
    response.status >= 500);
  try {
    const parsed = schema.safeParse(await response.json());
    if (parsed.success) return parsed.data;
  } catch { /* A malformed response is not safe display wording. */ }
  throw new ShipmentReadError("Shipment data could not be verified.",false);
}
export function retryShipmentRead(failureCount: number, error: Error): boolean {
  return failureCount < 2 && (error instanceof ShipmentReadError ? error.retryable : error instanceof TypeError);
}
