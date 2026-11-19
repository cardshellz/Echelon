import { Link, useParams, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { shipmentOrderContextSchema } from "@shared/shipment-access";
import { useAuth } from "@/lib/auth";
import { hasStaffCapability, SHIPMENT_CAPABILITIES } from "@shared/staff-capabilities";
import { readShipmentResource, retryShipmentRead } from "@/lib/shipment-reads";

export default function ShipmentOrderContext() {
  const { id } = useParams<{ id: string }>();
  const search = useSearch();
  // Reconstruct only known list filters; never accept an arbitrary redirect.
  const incoming = new URLSearchParams(search), filters = new URLSearchParams();
  for (const key of ["search","carrier","status","days","page"]) {
    const value = incoming.get(key); if (value) filters.set(key,value);
  }
  const back = "/outbound-shipments" + (filters.size ? "?" + filters.toString() : "");
  const { permissions } = useAuth();
  const allowed = hasStaffCapability(permissions, SHIPMENT_CAPABILITIES.orderContext);
  const validId = /^[1-9]\d*$/.test(id ?? "") && Number.isSafeInteger(Number(id));
  const query = useQuery({
    queryKey: ["/api/outbound-shipments", id, "order-context"],
    enabled: allowed && validId, retry: retryShipmentRead,
    queryFn: async ({ signal }) => {
      return readShipmentResource(`/api/outbound-shipments/${encodeURIComponent(id!)}/order-context`,shipmentOrderContextSchema,signal);
    },
  });
  return <main className="p-4 md:p-6 space-y-4" data-testid="shipment-order-context">
    <Link href={back} className="underline">Back to shipments</Link>
    <h1 className="text-2xl font-bold">Shipment order summary</h1>
    <p className="text-muted-foreground">Read-only fulfillment context for this shipment.</p>
    {!allowed ? <p role="alert">Order summary access is not permitted.</p>
      : !validId ? <p role="alert">This shipment link is invalid.</p>
      : query.isError ? <p role="alert">{query.error.message}</p>
      : !query.data ? <p role="status">Loading order summary…</p>
      : !query.data.order ? <p>No linked order is available for this shipment.</p>
      : <section className="space-y-3">
        <h2 className="text-xl">{query.data.order.orderNumber}</h2>
        <p>{query.data.order.customerName}</p>
        <p>Warehouse status: {query.data.order.warehouseStatus}{query.data.order.onHold ? " — on hold" : ""}</p>
        <table className="w-full text-left"><thead><tr><th>SKU</th><th>Item</th><th>Quantity</th><th>Picked</th><th>Status</th></tr></thead>
          <tbody>{query.data.order.items.map(item => <tr key={item.id}><td>{item.sku}</td><td>{item.name}</td><td>{item.quantity}</td><td>{item.pickedQuantity}</td><td>{item.status}</td></tr>)}</tbody>
        </table>
        {query.data.order.hasMoreItems && <p role="status">Showing the first 200 items. Ask an authorized order manager for the remaining details.</p>}
      </section>}
  </main>;
}
