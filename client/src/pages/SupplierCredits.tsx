import { supplierCreditCostLabel } from "@/features/purchasing/supplier-credit-presentation";
import { useEffect, useRef } from "react";
import { Link, useLocation, useParams, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { supplierCreditListSchema, supplierCreditListQuerySchema } from "@shared/procurement/supplier-credit";
import { formatPaymentCalendarDate } from "@shared/procurement/ap-payment-contract";
import { formatPaymentAmount } from "@/lib/ap-payment-command";
import { parseProcurementJourney, procurementBackHref, procurementRecordHref } from "@/lib/procurement-navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SupplierCreditCreate } from "@/features/purchasing/SupplierCreditCreate";
import { SupplierCreditDetail } from "@/features/purchasing/SupplierCreditDetail";
import { SupplierCreditRecovery } from "@/features/purchasing/SupplierCreditRecovery";
import { useSupplierCreditCommands } from "@/features/purchasing/use-supplier-credit-commands";
import { WorkListPagination } from "@/features/purchasing/WorkListPagination";

function queryId(params: URLSearchParams, key: string): number | null {
  const values = params.getAll(key);
  if (values.length !== 1 || !/^[1-9]\d*$/.test(values[0])) return null;
  const id = Number(values[0]);
  return Number.isSafeInteger(id) && id <= 2_147_483_647 ? id : null;
}
export default function SupplierCredits() {
  const [path, navigate] = useLocation();
  const search = useSearch(); const params = new URLSearchParams(search);
  const route = useParams<{ id?: string }>();
  const commands = useSupplierCreditCommands();
  const navigatedCommand = useRef<string | null>(null);
  const sourceInvoiceId = queryId(params, "sourceInvoiceId");
  const relatedInvoiceId = queryId(params, "invoiceId");
  const returnDispositionId = queryId(params, "returnDispositionId");
  const creditId = route.id && /^[1-9]\d*$/.test(route.id) && Number(route.id) <= 2_147_483_647 ? Number(route.id) : null;
  const creating = !route.id && params.getAll("new").length === 1 && params.get("new") === "1";
  const invalidContext = ["invoiceId", "replacesCreditId", "sourceInvoiceId", "vendorId", "returnDispositionId", "inboundShipmentId", "purchaseOrderId"].some(key => params.has(key) && queryId(params, key) === null);
  const query = supplierCreditListQuerySchema.safeParse({
    ...(sourceInvoiceId ? { sourceInvoiceId } : {}),
    ...(relatedInvoiceId ? { invoiceId: relatedInvoiceId } : {}),
    ...(queryId(params, "vendorId") ? { vendorId: queryId(params, "vendorId") } : {}),
    ...(params.get("status") ? { status: params.get("status") } : {}),
    search: params.get("search") ?? "", limit: 20, offset: params.get("offset") ?? "0",
  });
  const queryString = query.success ? new URLSearchParams(Object.entries(query.data).filter(([, value]) => value !== undefined && value !== "").map(([key, value]) => [key, String(value)])).toString() : "";
  const list = useQuery({
    queryKey: ["/api/supplier-credits", queryString, commands.userId], enabled: !route.id && !creating && !invalidContext && query.success,
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/supplier-credits?${queryString}`, { credentials: "include", signal });
      if (!response.ok) throw new Error("Supplier credits could not be loaded.");
      return supplierCreditListSchema.parse(await response.json());
    },
  });
  function change(values: Record<string, string | null>) {
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(values)) value === null ? next.delete(key) : next.set(key, value);
    navigate(`/supplier-credits${next.size ? `?${next}` : ""}`);
  }
  useEffect(() => {
    const result = commands.confirmed;
    if (result?.command !== "create") return;
    const identity = `${result.actorId}:${result.idempotencyKey}`;
    if (navigatedCommand.current === identity) return;
    // Consume recovery on the list as well: entering a later new draft must not
    // replay navigation to an earlier confirmed credit.
    navigatedCommand.current = identity;
    if (creating) navigate(procurementRecordHref({ kind: "credit", id: result.creditId, tab: "details" }, parseProcurementJourney(search)));
  }, [commands.confirmed, creating, navigate, search]);
  const detailHref = (id: number) => procurementRecordHref({ kind: "credit", id, tab: "details" }, parseProcurementJourney(search));
  return <div className="p-4 md:p-6 space-y-5 max-w-6xl mx-auto">
    <Link className="text-sm text-primary underline" href={procurementBackHref(search, "/supplier-credits")}>Back to {parseProcurementJourney(search).trail.length ? "source document" : "supplier credits"}
    </Link>
    <SupplierCreditRecovery commands={commands} />
    {route.id ? creditId ? <SupplierCreditDetail creditId={creditId} commands={commands} /> : <p role="alert">Invalid supplier credit identifier.</p> : invalidContext ? <p role="alert">Invalid supplier credit source. Reopen this workflow from its source document.</p> : creating ? <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Record supplier credit</h1>{commands.canCreate ? <SupplierCreditCreate commands={commands} initialInvoiceId={sourceInvoiceId ?? relatedInvoiceId} returnDispositionId={returnDispositionId} replacesCreditId={queryId(params, "replacesCreditId")} onCancel={() => change({ new: null })} /> : <p>Purchasing edit permission is required to record a supplier credit.</p>}
    </section> : <>
      <div className="flex flex-wrap gap-3 justify-between items-center">
        <div>
          <h1 className="text-2xl font-semibold">Supplier credits</h1>
          <p className="text-sm text-muted-foreground">Supplier documents, invoice applications and cost disposition. Cash payments remain separate.</p>
        </div>{commands.canCreate && <Button disabled={commands.blocked} onClick={() => change({ new: "1" })}>Record supplier credit</Button>}
      </div>
      {(params.has("inboundShipmentId") || params.has("purchaseOrderId") || returnDispositionId) && <p className="text-sm rounded border p-3">Choose the original supplier invoice for this credit. Shipment, purchase and return references guide review; they do not establish invoice ownership. This list shows {sourceInvoiceId ? "credits for the selected source invoice" : "all supplier credits"}.</p>}
      <div className="flex flex-wrap gap-3">
        <div className="flex-1 min-w-48">
          <Label htmlFor="credit-search">Search supplier credits</Label>
          <Input id="credit-search" value={params.get("search") ?? ""} maxLength={100} onChange={event => change({ search: event.target.value || null, offset: null })} />
        </div>
        <div>
          <Label htmlFor="credit-status">Credit status</Label>
          <select id="credit-status" className="flex h-10 rounded border bg-background px-3" value={params.get("status") ?? ""} onChange={event => change({ status: event.target.value || null, offset: null })}>
            <option value="">All statuses</option>
            <option value="draft">Draft</option>
            <option value="approved">Approved</option>
            <option value="voided">Voided</option>
          </select>
        </div>
      </div>
      {!query.success ? <p role="alert">Invalid supplier credit filters.</p> : list.isPending ? <p role="status">Loading supplier credits…</p> : list.isError ? <div role="alert">
        <p>Supplier credits are unavailable.</p>
        <Button onClick={() => void list.refetch()}>Retry supplier credits</Button>
      </div> : <>
        <div className="space-y-3">{list.data?.items.map(credit => <article key={credit.id} className="rounded border p-4 space-y-2">
          <div className="flex flex-wrap justify-between gap-2">
            <Link className="font-semibold text-primary underline" href={detailHref(credit.id)}>{credit.supplierReference}
            </Link>
            <span>{credit.status} · {formatPaymentCalendarDate({ paymentCalendarDate: credit.creditCalendarDate, paymentDateSource: "recorded_calendar_date" })}
            </span>
          </div>
          <p>{credit.vendorName} · Source invoice {credit.sourceInvoiceNumber}
          </p>
          <dl className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm">
            <div>
              <dt>Credit document</dt>
              <dd>{formatPaymentAmount(credit.totalAmountCents)}
              </dd>
            </div>
            <div>
              <dt>Applied to invoices</dt>
              <dd>{formatPaymentAmount(credit.appliedAmountCents)}
              </dd>
            </div>
            <div>
              <dt>Available credit</dt>
              <dd>{formatPaymentAmount(credit.unappliedAmountCents)}
              </dd>
            </div>
          </dl>
          <p className="text-sm">Cost disposition: {supplierCreditCostLabel(credit.costStatus)}
          </p>{credit.balanceIssues.map(issue => <p role="alert" key={issue.code}>{issue.message}
          </p>)}
        </article>)}{list.data?.items.length === 0 && <p>No supplier credits match these filters.</p>}
        </div>
        <WorkListPagination page={list.data} busy={list.isFetching} onOffset={offset => change({ offset: String(offset) })} label="supplier credits" />
      </>}
    </>}
  </div>;
}
