import { receiptReversalCapabilitySchema } from "@shared/procurement/receipt-reversal-command";
export function receiptReversalSourceCapability(raw: unknown): { allowed: boolean; reason: string | null } {
  const parsed = receiptReversalCapabilitySchema.safeParse(raw);
  if (!parsed.success) return { allowed: false, reason: "Supplier return history could not be verified. Reload this receipt before reversing." };
  return { allowed: parsed.data.allowed, reason: parsed.data.reason };
}
