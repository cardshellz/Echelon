import type { InventoryProductSyncProgress } from "@shared/types/inventory-product-sync";

export function productSyncState(row: InventoryProductSyncProgress["rows"][number], quantity: string): {
  label: string; terminal: boolean; verified: boolean;
} {
  if (row.state === "verified") {
    const verified = row.observedQuantity === quantity && row.observedAt !== null;
    return { label: verified ? "Verified at channel" : "Verification evidence unavailable", terminal: true, verified };
  }
  const labels = { desired: "Waiting to queue", queued: "Queued", leased: "Sending", acknowledged: "Accepted; checking channel",
    drifted: "Channel quantity differed", retryable: "Retry pending", dead_letter: "Delivery failed",
    superseded: "Replaced by a newer update", cancelled: "Cancelled" };
  return { label: labels[row.state], terminal: ["dead_letter", "superseded", "cancelled", "drifted"].includes(row.state), verified: false };
}
