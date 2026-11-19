import { z } from "zod";
import {
  customerOrderCancellationInputSchema,
  type CustomerOrderCancellationInput,
} from "@shared/customer-account/order-cancellation";

const savedSchema = z
  .object({
    version: z.literal(1),
    customerId: z.string().regex(/^[1-9]\d*$/),
    input: customerOrderCancellationInputSchema,
  })
  .strict();
export type CancellationRequestScope = {
  customerId: string;
  connectionId: number;
  omsOrderId: number;
};
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
function key(scope: CancellationRequestScope): string {
  z.string()
    .regex(/^[1-9]\d*$/)
    .parse(scope.customerId);
  z.number().int().positive().safe().parse(scope.connectionId);
  z.number().int().positive().safe().parse(scope.omsOrderId);
  return `csz-order-cancellation:v1:${scope.customerId}:${scope.connectionId}:${scope.omsOrderId}`;
}
export function loadCancellationRequest(
  storage: Storage,
  scope: CancellationRequestScope,
): CustomerOrderCancellationInput | null {
  const raw = storage.getItem(key(scope));
  if (raw === null) return null;
  if (raw.length > 2048)
    throw new Error(
      "The saved cancellation could not be verified. Contact us for help.",
    );
  const saved = savedSchema.parse(JSON.parse(raw));
  if (
    saved.customerId !== scope.customerId ||
    saved.input.connectionId !== scope.connectionId ||
    saved.input.omsOrderId !== scope.omsOrderId
  )
    throw new Error(
      "The saved cancellation belongs to a different order or account.",
    );
  return saved.input;
}
/** Persist approval before the network boundary. A timeout/reload must retain
 * the original command identity; it must never mint another cancellation. */
export function saveCancellationRequest(
  storage: Storage,
  scope: CancellationRequestScope,
  input: CustomerOrderCancellationInput,
): void {
  const saved = loadCancellationRequest(storage, scope);
  if (saved && JSON.stringify(saved) !== JSON.stringify(input))
    throw new Error(
      "Check the existing cancellation before starting another request.",
    );
  if (
    input.connectionId !== scope.connectionId ||
    input.omsOrderId !== scope.omsOrderId
  )
    throw new Error("The cancellation does not match this order.");
  const value = savedSchema.parse({
    version: 1,
    customerId: scope.customerId,
    input,
  });
  storage.setItem(key(scope), JSON.stringify(value));
}
export function clearCancellationRequest(
  storage: Storage,
  scope: CancellationRequestScope,
  requestKey: string,
): void {
  const saved = loadCancellationRequest(storage, scope);
  if (saved?.requestKey === requestKey) storage.removeItem(key(scope));
}
