import { z } from "zod";

const KEY = "csz:order-edit-payment-return:v1";
// A browser navigation hint, never payment evidence or an authorization grant.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const contextSchema = z
  .object({
    owner: z.string().regex(/^[1-9][0-9]*$/),
    connectionId: z.number().int().positive().safe(),
    omsOrderId: z.number().int().positive().safe(),
    operationId: z.string().uuid(),
    orderNumber: z.string().min(1).max(100),
    savedAt: z.number().int().nonnegative().safe(),
  })
  .strict();
type PaymentReturn = z.infer<typeof contextSchema>;
type StorageAccess = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const report = (code: string) =>
  console.warn(
    JSON.stringify({ event: "customer_order_edit_payment_return", code }),
  );

export function orderEditPaymentReturnStorage(): StorageAccess | null {
  try {
    return window.sessionStorage;
  } catch {
    report("PAYMENT_RETURN_STORAGE_UNAVAILABLE");
    return null;
  }
}

export function saveOrderEditPaymentReturn(
  input: Omit<PaymentReturn, "savedAt">,
  storage: StorageAccess,
  clock: () => number,
): void {
  const value = contextSchema.safeParse({ ...input, savedAt: clock() });
  if (!value.success) {
    report("PAYMENT_RETURN_CONTEXT_INVALID");
    return;
  }
  try {
    storage.setItem(KEY, JSON.stringify(value.data));
  } catch {
    report("PAYMENT_RETURN_STORAGE_UNAVAILABLE");
  }
}

function readContext(storage: StorageAccess): PaymentReturn | null {
  let raw: string | null;
  try {
    raw = storage.getItem(KEY);
  } catch {
    report("PAYMENT_RETURN_STORAGE_UNREADABLE");
    return null;
  }
  if (!raw) return null;
  try {
    const value = contextSchema.safeParse(JSON.parse(raw));
    if (value.success) return value.data;
  } catch {
    // Malformed browser data is discarded; it must not keep reopening a modal.
  }
  discardContext(storage);
  return null;
}

function discardContext(storage: StorageAccess): void {
  try {
    storage.removeItem(KEY);
  } catch {
    report("PAYMENT_RETURN_STORAGE_UNAVAILABLE");
  }
  report("PAYMENT_RETURN_CONTEXT_DISCARDED");
}

export function loadOrderEditPaymentReturn(
  owner: string,
  connectionId: number,
  storage: StorageAccess,
  clock: () => number,
): PaymentReturn | null {
  const value = readContext(storage);
  if (!value) return null;
  const now = clock();
  if (
    value.owner !== owner ||
    value.connectionId !== connectionId ||
    !Number.isSafeInteger(now) ||
    value.savedAt > now ||
    now - value.savedAt > MAX_AGE_MS
  ) {
    discardContext(storage);
    return null;
  }
  return value;
}

export function clearOrderEditPaymentReturn(
  owner: string,
  operationId: string,
  storage: StorageAccess,
): void {
  const value = readContext(storage);
  if (value?.owner === owner && value.operationId === operationId) {
    try {
      storage.removeItem(KEY);
    } catch {
      report("PAYMENT_RETURN_STORAGE_UNAVAILABLE");
    }
  }
}
