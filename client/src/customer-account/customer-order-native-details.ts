export interface CustomerOrderNativeAddress {
  kind: "shipping" | "billing";
  lines: string[];
}
/** Descriptive Shopify markup only. No HTML is inserted, and no native price or
 * original quantity can become edit, shipping, refund, or financial authority. */
export function readCustomerOrderNativeDetails(row: HTMLElement): {
  addresses: CustomerOrderNativeAddress[];
  originalQuantities: ReadonlyMap<string, number>;
} {
  const source = row.querySelector("[data-csz-native-order-details]");
  if (!(source instanceof HTMLTemplateElement))
    return { addresses: [], originalQuantities: new Map() };
  const addresses = (["shipping", "billing"] as const).flatMap((kind) => {
    const node = source.content.querySelector(
      `[data-csz-native-address='${kind}']`,
    );
    const lines = Array.from(node?.querySelectorAll("p") ?? [])
      .map((line) => line.textContent?.trim() ?? "")
      .filter(Boolean);
    return lines.length ? [{ kind, lines }] : [];
  });
  const originalQuantities = new Map<string, number>();
  const duplicates = new Set<string>();
  for (const line of source.content.querySelectorAll(
    "[data-csz-original-line-id]",
  )) {
    const id = line.getAttribute("data-csz-original-line-id") ?? "";
    const raw = line.getAttribute("data-csz-original-quantity") ?? "";
    if (!/^[1-9][0-9]{0,29}$/.test(id) || !/^[1-9][0-9]*$/.test(raw)) continue;
    const quantity = Number(raw);
    const key = `gid://shopify/LineItem/${id}`;
    if (!Number.isSafeInteger(quantity) || duplicates.has(key)) continue;
    if (originalQuantities.has(key)) {
      duplicates.add(key);
      originalQuantities.delete(key);
    } else originalQuantities.set(key, quantity);
  }
  return { addresses, originalQuantities };
}
