import type { InventoryStockSendProgress } from "@shared/types/inventory-stock-send";

export function stockSendState(row: InventoryStockSendProgress["rows"][number], quantity: string): { label: string; terminal: boolean; verified: boolean } {
  if (row.state === "verified") {
    const verified = row.observedQuantity === quantity && row.observedAt !== null;
    return { label: verified ? "Verified at Shopify" : "Verification evidence unavailable", terminal: true, verified };
  }
  const labels = { desired: "Waiting to queue", queued: "Queued", leased: "Sending", acknowledged: "Accepted; checking Shopify",
    drifted: "Shopify quantity differed", retryable: "Retry pending", dead_letter: "Delivery failed",
    superseded: "Replaced by a newer update", cancelled: "Cancelled" };
  return { label: labels[row.state], terminal: ["dead_letter", "superseded", "cancelled", "drifted"].includes(row.state), verified: false };
}
