import type { CustomerAccountOrderDetails } from "@shared/customer-account/customer-account-orders";
import { formatOrderEditMoney } from "@/lib/order-edits";
import { orderEditItemSubtotal } from "@/lib/order-edit-display";

interface ItemDescription {
  productUrl: string | null;
  imageUrl: string | null;
  trackingUrl: string | null;
  trackingNumber: string;
  descriptions: string[];
}

function httpsUrl(value: string | null): string | null {
  if (!value || value.length > 2048) return null;
  try {
    const url = new URL(value, location.origin);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Native markup contributes descriptions/links only, never quantities or prices. */
export function readOrderItemDescriptions(
  root: HTMLElement,
): ReadonlyMap<string, ItemDescription> {
  const template = root.querySelector("[data-csz-native-item-descriptions]");
  const descriptions = new Map<string, ItemDescription>();
  if (!(template instanceof HTMLTemplateElement)) return descriptions;
  const duplicates = new Set<string>();
  for (const node of template.content.querySelectorAll("[data-csz-native-item-id]")) {
    const numericId = node.getAttribute("data-csz-native-item-id") ?? "";
    if (!/^[1-9][0-9]{0,29}$/.test(numericId)) continue;
    const id = `gid://shopify/LineItem/${numericId}`;
    if (duplicates.has(id)) continue;
    if (descriptions.has(id)) {
      descriptions.delete(id);
      duplicates.add(id);
      continue;
    }
    descriptions.set(id, {
      productUrl: httpsUrl(node.querySelector("[data-csz-native-product-link]")?.getAttribute("href") ?? null),
      imageUrl: httpsUrl(node.querySelector("img")?.getAttribute("src") ?? null),
      trackingUrl: httpsUrl(node.querySelector("[data-csz-native-tracking-link]")?.getAttribute("href") ?? null),
      trackingNumber: node.querySelector("[data-csz-native-tracking-link]")?.textContent?.trim() ?? "",
      descriptions: Array.from(node.querySelectorAll("[data-csz-native-item-description]"))
        .map((item) => item.textContent?.trim() ?? "")
        .filter(Boolean),
    });
  }
  return descriptions;
}

/** One owned detail read supplies all current item quantities and money. */
export function CustomerOrderCurrentItems({
  details,
  descriptions,
}: {
  details: CustomerAccountOrderDetails;
  descriptions: ReadonlyMap<string, ItemDescription>;
}) {
  const lines = details.lines.filter((line) => line.quantity > 0);
  if (!lines.length) return <p>This order has no current items.</p>;
  return (
    <ul className="csz-detail-items">
      {lines.map((line) => {
        const native = descriptions.get(line.lineItemId);
        const net = orderEditItemSubtotal(
          details.financials,
          line.lineItemId,
          line.totalCents,
        );
        const gross = details.financials?.lines.find(
          (item) => item.id === line.lineItemId,
        )?.grossCents;
        return (
          <li key={line.lineItemId} data-csz-current-line-id={line.lineItemId}>
            {native?.imageUrl && (
              <img src={native.imageUrl} width={60} height={60} loading="lazy" alt="" />
            )}
            <div className="csz-detail-item-name">
              {native?.productUrl
                ? <a href={native.productUrl}>{line.title}</a>
                : <span>{line.title}</span>}
              {line.variantTitle && <small>{line.variantTitle}</small>}
              {line.sku && <small>SKU {line.sku}</small>}
              {native?.descriptions.map((text, index) => <small key={index}>{text}</small>)}
              {native?.trackingUrl && (
                <a className="csz-account-link" href={native.trackingUrl}>
                  Track shipment{native.trackingNumber ? ` · ${native.trackingNumber}` : ""}
                </a>
              )}
            </div>
            <span className="csz-detail-quantity">Qty {line.quantity}</span>
            <div className="csz-detail-item-total">
              {gross !== undefined && gross > net && (
                <s>{formatOrderEditMoney(gross, details.currency)}</s>
              )}
              <strong>{formatOrderEditMoney(net, details.currency)}</strong>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
