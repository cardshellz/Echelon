export type ScannablePickItem = {
  sku: string;
  barcode?: string | null;
  status?: string | null;
  picked?: number | null;
  qty?: number | null;
};

export function normalizeScanCode(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, "");
}

export function itemScanCodes(item: ScannablePickItem): string[] {
  return [normalizeScanCode(item.sku), normalizeScanCode(item.barcode)]
    .filter((code): code is string => code.length > 0);
}

export function scanMatchesItem(value: string, item: ScannablePickItem): boolean {
  const normalized = normalizeScanCode(value);
  return normalized.length > 0 && itemScanCodes(item).includes(normalized);
}

export function scanCouldStillMatchItem(value: string, item: ScannablePickItem): boolean {
  const normalized = normalizeScanCode(value);
  return normalized.length > 0 && itemScanCodes(item).some(code => code.startsWith(normalized));
}

export function isScannablePickItem(item: ScannablePickItem): boolean {
  if (item.status === "completed" || item.status === "short") return false;
  if (typeof item.qty === "number" && typeof item.picked === "number" && item.picked >= item.qty) {
    return false;
  }
  return true;
}

export function findMatchingScannableItemIndex<T extends ScannablePickItem>(
  items: T[],
  value: string,
): number {
  return items.findIndex(item => isScannablePickItem(item) && scanMatchesItem(value, item));
}
