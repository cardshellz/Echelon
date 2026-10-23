import React, { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useSearch } from "wouter";
import { relationshipSnapshotSchema, projectDocumentRelationships, receivedRelationshipPieces,
  type RelationshipRoot, type RelationshipAmounts, type RelationshipLine, type RelationshipSnapshot } from "@shared/procurement/document-relationships";
import { projectPurchaseLineShipping } from "@shared/procurement/purchase-line-shipping";
import { useProcurementNavigation } from "@/hooks/use-procurement-navigation";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export function relationshipQueryKey(root: RelationshipRoot) {
  // Existing command invalidations refresh the relationship projection too.
  return root.kind === "receipt" ? ["/api/receiving", "relationships", root.id] as const
    : [`/api/${root.kind === "purchase" ? "purchase-orders" : "inbound-shipments"}/${root.id}`, "relationships"] as const;
}
export async function loadDocumentRelationships(root: RelationshipRoot, signal?: AbortSignal): Promise<RelationshipSnapshot> {
  const response = await fetch(`/api/procurement/relationships/${root.kind}/${root.id}`, { credentials: "include", signal });
  if (!response.ok) throw new Error(response.status === 403 ? "You need purchasing view access to see these document links."
    : response.status === 404 ? "This document is no longer available." : "Document links and cost shares could not be loaded.");
  const data = relationshipSnapshotSchema.parse(await response.json());
  if (data.root.kind !== root.kind || data.root.id !== root.id) throw new Error("The document links belong to a different record. Reload this section.");
  projectPurchaseLineShipping(data); // Reject incomplete identities/unsafe totals at the read boundary.
  return data;
}

/** Integer cents are formatted without using a rounded per-piece cost. */
function amount(cents: number, currency: string) {
  const value = BigInt(cents); const absolute = value < BigInt(0) ? -value : value;
  return `${value < BigInt(0) ? "−" : ""}${currency} ${(absolute / BigInt(100)).toLocaleString("en-US")}.${String(absolute % BigInt(100)).padStart(2, "0")}`;
}
function Amounts({ value }: { value: RelationshipAmounts }) {
  return <span className="font-mono tabular-nums">{value.amounts.length ? value.amounts.map(row => amount(row.cents, row.currency)).join(" + ") : "—"}{value.incomplete && " · incomplete"}</span>;
}
const issueLabel = { conflicting_po: "PO links disagree", missing_po: "PO not linked", missing_po_line: "PO line not linked" };

export interface DocumentRelationshipsProps {
  root: RelationshipRoot;
  purchaseId?: number;
  lineActions?: (line: RelationshipLine) => React.ReactNode;
}

/** The same line trail and share calculation is used in all document surfaces. */
export function DocumentRelationships({ root, purchaseId, lineActions }: DocumentRelationshipsProps) {
  const query = useQuery({ queryKey: relationshipQueryKey(root), queryFn: ({ signal }) => loadDocumentRelationships(root, signal) });
  const navigation = useProcurementNavigation();
  const [path, navigate] = useLocation();
  const search = useSearch();
  const projected = useMemo(() => query.data ? projectDocumentRelationships(query.data) : [], [query.data]);
  const scope = navigation.record?.relationship?.po ?? purchaseId ?? (root.kind === "purchase" ? root.id : "all");
  const selectedLine = navigation.record?.relationship?.line ?? null;
  function setSelection(po: number | "all", line: number | null = null) {
    const params = new URLSearchParams(search);
    params.set("poScope", String(po));
    if (line !== null) params.set("shipmentLine", String(line)); else params.delete("shipmentLine");
    navigate(`${path}?${params}`);
  }
  if (query.isPending) return <p role="status" className="rounded-md border p-4 text-sm">Loading linked POs, shipments and receipts…</p>;
  if (query.isError || !query.data) return <div role="alert" className="rounded-md border border-destructive p-4 text-sm space-y-2">
    <p>{query.error instanceof Error ? query.error.message : "Document links could not be verified."}</p>
    <Button variant="outline" size="sm" onClick={() => void query.refetch()}>Retry document links</Button>
  </div>;
  const data = query.data;
  const current = navigation.record;
  // An inline lifecycle inspector is still on the PO page. Its return label
  // must identify the page, not the shipment being inspected inside it.
  const rootNumber = current?.kind === "purchase" ? data.purchases.find(po => po.id === current.id)?.number
    : current?.kind === "shipment" ? data.shipments.find(shipment => shipment.id === current.id)?.number
      : data.receipts.find(receipt => receipt.id === current?.id)?.number;
  function href(kind: RelationshipRoot["kind"], id: number, number: string, po: number | "all" | null, line?: number) {
    const url = kind === "purchase" ? `/purchase-orders/${id}?tab=shipments` : kind === "shipment" ? `/shipments/${id}?tab=lines` : `/receiving?open=${id}`;
    return navigation.childHref(`${url}&document=${encodeURIComponent(number)}${po !== null ? `&poScope=${po}` : ""}${line ? `&shipmentLine=${line}` : ""}`,
      { currentLabel: rootNumber, currentRelationship: { po: scope, line: line ?? selectedLine } });
  }
  const selectedShipments = scope === "all" ? projected : projected.filter(shipment => shipment.groups.some(group => group.purchaseId === scope || group.purchaseId === null));
  const poLines = new Map(data.purchaseLines.map(line => [line.id, line]));
  const shipmentLines = new Map(data.shipmentLines.map(line => [line.id, line]));
  const receiptsById = new Map(data.receipts.map(receipt => [receipt.id, receipt]));
  const receiptOrphans = data.receiptLines.filter(line => line.shipmentLineId === null || !shipmentLines.has(line.shipmentLineId));
  const relevantOrphans = receiptOrphans.filter(line => root.kind !== "receipt" || line.receiptId === root.id);
  const linkedPurchaseLines = new Set(data.shipmentLines.map(line => line.purchaseLineId));
  const unshipped = root.kind === "purchase" ? data.purchaseLines.filter(line => line.purchaseId === root.id
    && !linkedPurchaseLines.has(line.id)) : [];
  return <section aria-label="PO, shipment and receipt connections" className="space-y-4 min-w-0">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h3 className="font-semibold">POs, shipments and receipts</h3><p className="text-xs text-muted-foreground">Follow each line from the ordered pieces to its shipment and receipt.</p></div>
      <label className="text-sm flex items-center gap-2">Show PO
        <select aria-label="Show purchase order" className="h-9 max-w-full rounded-md border bg-background px-2" value={scope}
          onChange={event => setSelection(event.target.value === "all" ? "all" : Number(event.target.value))}>
          <option value="all">All linked POs</option>
          {data.purchases.map(po => <option key={po.id} value={po.id}>{po.number}</option>)}
        </select>
      </label>
    </div>
    {data.costIssues.length > 0 && <div role="status" className="rounded-md border border-amber-400 p-3 text-sm">{data.costIssues.join(" ")} Review the shipment costs before using these shares as final totals.</div>}
    {selectedShipments.length === 0 && <p className="text-sm text-muted-foreground">No shipment lines linked to this PO.</p>}
    {selectedShipments.map(({ shipment, groups, charges, allocationIncomplete }) => <article key={shipment.id} className="rounded-lg border bg-card" aria-label={`Shipment ${shipment.number}`}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b p-4">
        <div><Link className="font-semibold text-primary hover:underline" href={href("shipment", shipment.id, shipment.number, scope)}>Shipment {shipment.number}</Link>
          <p className="text-xs text-muted-foreground mt-1">{shipment.status.replaceAll("_", " ")} · {groups.filter(group => group.purchaseId !== null).length} POs · {groups.reduce((sum, group) => sum + group.lines.length, 0)} lines</p></div>
        <div className="text-sm text-left sm:text-right"><p className="text-xs text-muted-foreground">Whole shipment charges, after credits</p><Amounts value={charges} />
          {allocationIncomplete && <p className="text-xs text-amber-700 mt-1">Allocation is incomplete. <Link className="underline" href={navigation.childHref(`/shipments/${shipment.id}?tab=allocation&document=${encodeURIComponent(shipment.number)}`, { currentLabel: rootNumber })}>Review costs</Link></p>}</div>
      </header>
      {groups.filter(group => scope === "all" || group.purchaseId === scope || group.purchaseId === null).map(group => <section key={group.key} aria-label={group.number ?? "Unlinked shipment lines"} className="border-b last:border-b-0">
        <div className="flex flex-wrap items-start justify-between gap-2 bg-muted/40 px-4 py-3">
          <div>{group.purchaseId !== null && group.number ? <Link className="font-medium text-primary hover:underline" href={href("purchase", group.purchaseId, group.number, group.purchaseId)}>{group.number}</Link>
            : <span className="font-medium text-amber-700">{group.key === "conflicting_po" ? "Conflicting PO links" : "PO not linked"}</span>}
            <p className="text-xs text-muted-foreground">{group.lines.length} {group.lines.length === 1 ? "line" : "lines"} · {group.shippedPieces.toLocaleString()} pieces on this shipment</p></div>
          <div className="text-sm text-left sm:text-right"><p className="text-xs text-muted-foreground">{group.purchaseId === null ? "Unassigned share" : "This PO’s allocated share"}</p><Amounts value={group.costs} /></div>
        </div>
        <div className="@container/relationships"><Table className="block @4xl/relationships:table">
          <TableHeader className="hidden @4xl/relationships:table-header-group"><TableRow><TableHead>PO line / product</TableHead><TableHead className="text-right">PO ordered</TableHead><TableHead className="text-right">On this shipment</TableHead><TableHead>Receiving</TableHead><TableHead className="text-right">Allocated charges</TableHead><TableHead><span className="sr-only">Line details</span></TableHead></TableRow></TableHeader>
          <TableBody className="block @4xl/relationships:table-row-group">{group.lines.map(({ line, owner, receipts, costs }) => <React.Fragment key={line.id}>
            <TableRow data-testid={`relationship-line-${line.id}`} className={`grid grid-cols-2 @4xl/relationships:table-row ${selectedLine === line.id ? "bg-primary/5" : ""}`}>
              <TableCell className="block col-span-2 min-w-0 @4xl/relationships:table-cell"><span className="text-xs text-muted-foreground">{owner.purchaseLine ? `PO line ${owner.purchaseLine.lineNumber}` : "PO line unknown"}</span><p className="font-mono text-xs break-words">{line.sku ?? "SKU not recorded"}</p><p className="text-xs max-w-64">{line.product ?? owner.purchaseLine?.product}</p>
                {owner.issue && <p className="text-xs text-amber-700">{issueLabel[owner.issue]}</p>}</TableCell>
              <TableCell className="block tabular-nums @4xl/relationships:table-cell @4xl/relationships:text-right"><span className="block text-xs text-muted-foreground @4xl/relationships:hidden">PO ordered</span>{owner.issue === null ? owner.purchaseLine?.orderedPieces.toLocaleString() : "—"}</TableCell>
              <TableCell className="block tabular-nums @4xl/relationships:table-cell @4xl/relationships:text-right"><span className="block text-xs text-muted-foreground @4xl/relationships:hidden">On this shipment</span>{line.shippedPieces.toLocaleString()}</TableCell>
              <TableCell className="block col-span-2 text-xs space-y-1 @4xl/relationships:table-cell"><span className="block text-muted-foreground @4xl/relationships:hidden">Receiving</span>{receipts.length ? receipts.map(receiptLine => {
                const receipt = receiptsById.get(receiptLine.receiptId); const pieces = receivedRelationshipPieces(receiptLine);
                if (!receipt) return <p key={receiptLine.id}>Receipt link missing</p>;
                const differentPoLine = receiptLine.purchaseLineId !== null && receiptLine.purchaseLineId !== line.purchaseLineId;
                return <div key={receiptLine.id}><Link className="text-primary underline" href={href("receipt", receipt.id, receipt.number, group.purchaseId, line.id)}>{receipt.number}</Link>
                  <p>{root.kind === "receipt" && receipt.id === root.id && <strong>This receipt · </strong>}{pieces === null ? `${receiptLine.receivedUnits.toLocaleString()} receive units · piece conversion not saved` : `${pieces.toLocaleString()} pieces received`} · {receipt.status}</p>
                  {differentPoLine && <p className="text-amber-700">Receipt points to a different PO line. Review its link.</p>}</div>;
              }) : <span className="text-muted-foreground">No receipt line linked</span>}</TableCell>
              <TableCell className="block col-span-2 text-xs @4xl/relationships:table-cell @4xl/relationships:text-right"><span className="block text-muted-foreground @4xl/relationships:hidden">Allocated charges</span><Amounts value={costs} /></TableCell>
              <TableCell className="flex col-span-2 flex-wrap gap-2 @4xl/relationships:table-cell"><Button size="sm" variant="ghost" aria-expanded={selectedLine === line.id} onClick={() => setSelection(scope, selectedLine === line.id ? null : line.id)}>{selectedLine === line.id ? "Hide details" : "Line details"}</Button>{lineActions?.(line)}</TableCell>
            </TableRow>
            {selectedLine === line.id && <TableRow className="block @4xl/relationships:table-row"><TableCell colSpan={6} className="block bg-muted/30 text-sm @4xl/relationships:table-cell">
              <p>PO line {owner.purchaseLine?.lineNumber ?? "unknown"} → shipment {shipment.number} → {receipts.length} linked receipt lines.</p>
              {owner.issue && <p className="text-amber-700">{issueLabel[owner.issue]}. Review the saved PO reference before assigning this line’s costs.</p>}
              {owner.purchaseLine && <p className="text-xs text-muted-foreground">The PO ordered quantity applies to the whole PO line, including other shipments. This shipment and its receipts keep their own counts.</p>}
            </TableCell></TableRow>}
          </React.Fragment>)}</TableBody>
        </Table></div>
      </section>)}
    </article>)}
    {unshipped.length > 0 && <div className="rounded-lg border p-4 text-sm"><h4 className="font-medium">PO lines without a shipment link</h4>{unshipped.map(line => <p key={line.id} className="mt-1">Line {line.lineNumber} · {line.sku ?? line.product} · {line.orderedPieces.toLocaleString()} ordered pieces</p>)}</div>}
    {relevantOrphans.length > 0 && <div className="rounded-lg border p-4 text-sm"><h4 className="font-medium">Receipt lines without a shipment-line link</h4>
      <p className="text-xs text-muted-foreground">These receipt counts are saved. They have not been assigned to a shipment line.</p>
      {relevantOrphans.map(line => { const receipt = receiptsById.get(line.receiptId); const poLine = line.purchaseLineId === null ? null : poLines.get(line.purchaseLineId);
        const po = data.purchases.find(row => row.id === poLine?.purchaseId); const pieces = receivedRelationshipPieces(line);
        return <p key={line.id} className="mt-2">{receipt && <Link className="text-primary underline" href={href("receipt", receipt.id, receipt.number, po?.id ?? null)}>{receipt.number}</Link>} · {po?.number ?? "PO not linked"} · {line.sku ?? "SKU not recorded"} · {pieces === null ? `${line.receivedUnits.toLocaleString()} receive units` : `${pieces.toLocaleString()} pieces`}.</p>;
      })}
    </div>}
  </section>;
}
