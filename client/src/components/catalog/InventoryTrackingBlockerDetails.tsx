import type { InventoryTrackingBlocker, InventoryTrackingEvidenceRecord } from "@shared/catalog/bulk-inventory-tracking";

const nextSteps: Record<string, string> = {
  stock: "Verify the physical count and reconcile the recorded quantities in Inventory. Picked or packed quantities need their order history checked before correction.",
  lots: "Reconcile these lots through the inventory workflow. Changing tracking does not write off stock or clear custody quantities.",
  open_orders: "Complete or resolve the warehouse work before changing tracking.",
  oms_orders: "Resolve the sales order in OMS. A cancelled warehouse order does not establish that the sales order is cancelled.",
  claims: "Complete or release the inventory claim through its owning order workflow.",
  resources: "Complete or release the claimed resources through their owning workflow.",
  publication: "Resolve the pending inventory publication, then refresh this review.",
};

function OrderLink({ system, id, number }: { system: "oms" | "wms"; id: number; number: string | null }) {
  return <a className="underline" target="_blank" rel="noopener noreferrer"
    href={`${system === "oms" ? "/oms/orders" : "/orders"}?orderId=${id}`}>
    {system === "oms" ? "Sales order" : "Warehouse order"} {number ?? id} (ID {id})
  </a>;
}

function EvidenceRecord({ record }: { record: InventoryTrackingEvidenceRecord }) {
  switch (record.kind) {
    case "stock":
    case "lots": return <>
      <p>{record.kind === "lots" ? `Lot ${record.lotNumber} (ID ${record.recordId})` : `Stock record ${record.recordId}`} · {record.locationCode ?? "Unknown location"} (location {record.locationId})</p>
      <p>On hand {record.onHand} · Reserved {record.reserved} · Picked {record.picked} · Packed {record.packed}{record.kind === "stock" && ` · Backorder ${record.backorder}`}</p>
    </>;
    case "open_orders": return <>
      <p><OrderLink system="wms" id={record.orderId} number={record.orderNumber} /> · {record.status}</p>
      <p>Item {record.recordId}: {record.itemStatus} · Ordered {record.quantity} · Picked {record.picked} · Fulfilled {record.fulfilled}</p>
    </>;
    case "oms_orders": return <>
      <p><OrderLink system="oms" id={record.orderId} number={record.orderNumber} /> · {record.status} · {record.fulfillmentStatus ?? "Fulfillment status unknown"}</p>
      <p>Line {record.recordId} · Ordered {record.quantity}</p>
      {record.warehouseOrders.map(order => <p key={order.orderId}><OrderLink system="wms" id={order.orderId} number={order.orderNumber} /> · {order.status}</p>)}
      {record.warehouseOrderCount === 0 && <p>No linked warehouse order recorded.</p>}
      {record.warehouseOrderCount > record.warehouseOrders.length && <p>Showing {record.warehouseOrders.length} of {record.warehouseOrderCount} linked warehouse orders.</p>}
    </>;
    case "claims": return <>
      <p>Claim {record.claimId} · Claim line {record.recordId} · Order item {record.orderItemId}</p>
      <p>Planned {record.planned} · Released {record.released} · Consumed {record.consumed}</p>
    </>;
    case "resources": return <>
      <p>Claim {record.claimId} · Resource {record.recordId} · {record.locationCode ?? "Unknown location"} (location {record.locationId})</p>
      <p>Claimed {record.claimed} · Released {record.released} · Consumed {record.consumed}</p>
    </>;
    case "publication": return <p>Publication {record.recordId} · {record.state}</p>;
  }
}

export function InventoryTrackingBlockerDetails({ blocker }: { blocker: InventoryTrackingBlocker }) {
  return <div className="space-y-1 text-xs break-words">
    <p className="text-destructive">{blocker.message}</p>
    {blocker.evidence && <>
      <ul className="space-y-2 border-l-2 pl-3">
        {blocker.evidence.records.map(record => <li key={`${record.kind}-${record.recordId}`}><EvidenceRecord record={record} /></li>)}
      </ul>
      {blocker.evidence.totalCount > blocker.evidence.records.length && <p className="font-medium">Showing {blocker.evidence.records.length} of {blocker.evidence.totalCount} blocking records. Review the remaining records in the owning workflow.</p>}
      {blocker.evidence.totalCount === 0 && <p>Dependencies changed while this review was loading. Refresh the review.</p>}
    </>}
    {nextSteps[blocker.code] && <p className="text-muted-foreground">{nextSteps[blocker.code]}</p>}
    {["stock", "lots"].includes(blocker.code) && <a href="/inventory" target="_blank" rel="noopener noreferrer" className="inline-block underline">Open Inventory</a>}
  </div>;
}
