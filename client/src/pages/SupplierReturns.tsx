import { supplierReturnResultId } from "@/lib/supplier-return-command";
import React, { useEffect, useRef } from "react";
import { Link, useLocation, useParams, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { supplierReturnListSchema, supplierReturnListQuerySchema } from "@shared/procurement/supplier-return";
import { formatPaymentCalendarDate } from "@shared/procurement/ap-payment-contract";
import { parseProcurementJourney, procurementBackHref, procurementRecordHref } from "@/lib/procurement-navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { apVendorOptionsQuery } from "@/features/purchasing/ap-work-list-query";
import { SupplierReturnCreate } from "@/features/purchasing/SupplierReturnCreate";
import { SupplierReturnDetail, returnCreditLabels } from "@/features/purchasing/SupplierReturnDetail";
import { SupplierReturnRecovery } from "@/features/purchasing/SupplierReturnRecovery";
import { SupplierReturnValue } from "@/features/purchasing/SupplierReturnValue";
import { useSupplierReturnCommands } from "@/features/purchasing/use-supplier-return-commands";
function queryId(params: URLSearchParams, key: string): number | null {
  const values = params.getAll(key);
  if (values.length !== 1 || !/^[1-9]\d*$/.test(values[0])) return null;
  const id = Number(values[0]); return Number.isSafeInteger(id) ? id : null;
}
export default function SupplierReturns() {
  const [, navigate] = useLocation(); const search = useSearch(); const params = new URLSearchParams(search);
  const route = useParams<{ id?: string }>(); const commands = useSupplierReturnCommands();
  const navigatedCommand = useRef<string | null>(null);
  const vendorId = queryId(params, "vendorId"), purchaseOrderId = queryId(params, "purchaseOrderId"), receivingOrderId = queryId(params, "receivingOrderId");
  const returnId = route.id && /^[1-9]\d*$/.test(route.id) && Number.isSafeInteger(Number(route.id)) ? Number(route.id) : null;
  const creating = !route.id && params.getAll("new").length === 1 && params.get("new") === "1";
  const invalidContext = ["vendorId", "purchaseOrderId", "receivingOrderId", "afterId"].some(key => params.has(key) && queryId(params, key) === null);
  const filters = supplierReturnListQuerySchema.safeParse({ ...(vendorId ? { vendorId } : {}), ...(purchaseOrderId ? { purchaseOrderId } : {}), ...(receivingOrderId ? { receivingOrderId } : {}), ...(queryId(params, "afterId") ? { afterId: queryId(params, "afterId") } : {}), limit: 25 });
  const queryString = filters.success ? new URLSearchParams(Object.entries(filters.data).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])).toString() : "";
  const vendors = useQuery({ ...apVendorOptionsQuery, enabled: !route.id && !creating });
  const list = useQuery({ queryKey: ["/api/supplier-returns", queryString, commands.userId], enabled: !route.id && !creating && !invalidContext && filters.success, retry: false, staleTime: 0,
    queryFn: async ({ signal }) => { const response = await fetch(`/api/supplier-returns?${queryString}`, { credentials: "include", signal }); if (!response.ok) throw new Error("Supplier returns could not be loaded."); return supplierReturnListSchema.parse(await response.json()); },
  });
  function change(values: Record<string, string | null>) { const next = new URLSearchParams(search); for (const [key, value] of Object.entries(values)) value === null ? next.delete(key) : next.set(key, value); navigate(`/supplier-returns${next.size ? `?${next}` : ""}`); }
  useEffect(() => {
    const result = commands.confirmed; if (!result || result.command !== "record") return;
    const identity = `${result.actorId}:${result.idempotencyKey}`; if (navigatedCommand.current === identity) return;
    navigatedCommand.current = identity;
    if (creating) navigate(procurementRecordHref({ kind: "supplier-return", id: result.returnId, tab: "details" }, parseProcurementJourney(search)));
  }, [commands.confirmed, creating, navigate, search]);
  return <main className="p-4 md:p-6 space-y-5 max-w-6xl mx-auto">
    <Link className="text-sm text-primary underline" href={procurementBackHref(search, "/supplier-returns")}>Back to {parseProcurementJourney(search).trail.length ? "source document" : "supplier returns"}</Link>
    <SupplierReturnRecovery commands={commands} />
    {commands.confirmed && !creating && !route.id && <p className="rounded border p-3 text-sm">{commands.confirmed.command === "record" ? "Return confirmed." : "Credit difference review confirmed."} <Link className="text-primary underline" href={procurementRecordHref({ kind: "supplier-return", id: supplierReturnResultId(commands.confirmed), tab: "details" }, parseProcurementJourney(search))}>View recorded supplier return #{supplierReturnResultId(commands.confirmed)}</Link></p>}
    {route.id ? returnId ? <SupplierReturnDetail returnId={returnId} commands={commands} /> : <p role="alert">Invalid supplier return identifier.</p> : invalidContext || !filters.success ? <p role="alert">Invalid supplier return source or filters. Reopen this workflow from its source document.</p> : creating ? <><h1 className="text-2xl font-semibold">Return accepted stock to supplier</h1>{commands.canApprove ? <SupplierReturnCreate key={`${vendorId}:${purchaseOrderId}:${receivingOrderId}`} commands={commands} initialVendorId={vendorId} purchaseOrderId={purchaseOrderId} receivingOrderId={receivingOrderId} onCancel={() => change({ new: null })} /> : <p>Purchasing approval permission is required to record a physical supplier return.</p>}</> : <>
      <header className="flex flex-wrap justify-between items-center gap-3"><div><h1 className="text-2xl font-semibold">Supplier returns</h1><p className="text-sm text-muted-foreground">Accepted stock returned to a supplier, its retained value history and credit matching.</p></div>{commands.canApprove && <Button disabled={commands.blocked} onClick={() => change({ new: "1", afterId: null })}>Return accepted stock</Button>}</header>
      <div><Label htmlFor="return-list-vendor">Filter by supplier</Label><select id="return-list-vendor" className="w-full sm:max-w-md block rounded border bg-background p-2" value={vendorId ?? ""} onChange={event => change({ vendorId: event.target.value || null, afterId: null })}><option value="">All suppliers</option>{vendors.data?.map(vendor => <option key={vendor.id} value={vendor.id}>{vendor.name}</option>)}</select>{vendors.isError && <Button variant="outline" onClick={() => void vendors.refetch()}>Retry supplier filters</Button>}</div>
      {(purchaseOrderId || receivingOrderId) && <p className="text-sm">Showing returns linked to {purchaseOrderId ? `purchase #${purchaseOrderId}` : ""}{purchaseOrderId && receivingOrderId ? " and " : ""}{receivingOrderId ? `receipt #${receivingOrderId}` : ""}.</p>}
      {list.isPending ? <p role="status">Loading supplier returns…</p> : list.isError ? <div role="alert"><p>Supplier returns are unavailable.</p><Button onClick={() => void list.refetch()}>Retry supplier returns</Button></div> : <>
        {list.data.items.map(item => <article className="rounded border p-4 space-y-3" key={item.id}><div className="flex flex-wrap justify-between gap-2"><Link className="font-semibold text-primary underline" href={procurementRecordHref({ kind: "supplier-return", id: item.id, tab: "details" }, parseProcurementJourney(search))}>Supplier return #{item.id}</Link><span>{formatPaymentCalendarDate({ paymentCalendarDate: item.returnCalendarDate, paymentDateSource: "recorded_calendar_date" })}</span></div><p>{item.vendorName} · {item.evidenceReference}</p><p>{item.returnedBasePieces.toLocaleString()} pieces returned · {returnCreditLabels[item.creditState]}</p><SupplierReturnValue value={item.currentCosts} label="Current returned value" /></article>)}
        {list.data.items.length === 0 && <p>No supplier returns match these filters.</p>}
        <nav aria-label="Supplier return pages" className="flex flex-wrap gap-3">{params.has("afterId") && <Button variant="outline" disabled={list.isFetching} onClick={() => change({ afterId: null })}>First returns</Button>}{list.data.nextAfterId !== null && <Button variant="outline" disabled={list.isFetching} onClick={() => change({ afterId: String(list.data.nextAfterId) })}>Older returns</Button>}</nav>
      </>}
    </>}
  </main>;
}
