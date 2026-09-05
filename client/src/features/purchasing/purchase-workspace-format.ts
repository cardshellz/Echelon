import { format, parseISO } from "date-fns";

/** Keep null distinct from a recorded zero and preserve signed credit amounts. */
export function formatWorkspaceMoney(cents: number | null, currency: string | null): string {
  if (cents === null) return "Not recorded";
  if (!Number.isSafeInteger(cents)) throw new RangeError("Workspace money must be safe integer cents.");
  const amount = BigInt(cents);
  const absolute = amount < BigInt(0) ? -amount : amount;
  const dollars = (absolute / BigInt(100)).toLocaleString("en-US");
  const fraction = (absolute % BigInt(100)).toString().padStart(2, "0");
  const numeric = `${amount < BigInt(0) ? "-" : ""}${dollars}.${fraction}`;
  if (currency === "USD") return `${amount < BigInt(0) ? "-" : ""}$${dollars}.${fraction}`;
  return `${numeric} ${currency?.trim() || "(currency not recorded)"}`;
}

export function formatWorkspaceDate(value: string | null): string {
  if (value === null) return "Not recorded";
  const date = parseISO(value);
  return Number.isFinite(date.getTime()) ? format(date, "MMM d, yyyy") : "Date unavailable";
}

export function formatWorkspaceStatus(value: string | null): string {
  if (!value) return "Not recorded";
  return value.replace(/_/g, " ").replace(/^./, (first) => first.toUpperCase());
}
