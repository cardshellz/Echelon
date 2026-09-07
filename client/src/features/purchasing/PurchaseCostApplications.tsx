import React from "react";
import { Link } from "wouter";
import type { PurchaseWorkspace } from "@shared/procurement/purchase-workspace";
import type { PurchaseCostApplicationHistory } from "@shared/procurement/purchase-cost-applications";
import type { ReceiptCostRequestHistory } from "@shared/procurement/receipt-cost-queue";
import type { ProcurementNavigation } from "@/hooks/use-procurement-navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatWorkspaceDate, formatWorkspaceMills, formatWorkspaceMoney, formatWorkspaceStatus } from "./purchase-workspace-format";

export interface ReceiptCostActions {
  canRetry: boolean;
  pendingReceiptId: number | null;
  onRetry: (receiptId: number) => void;
  message: string | null;
  error: string | null;
}
type Revision = PurchaseCostApplicationHistory["revisions"][number];

function EvidenceIssues({ issues }: { issues: readonly { code: string; message: string }[] }) {
  return issues.length > 0 ? <ul className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-800 dark:text-amber-300">{issues.map((issue, index) => <li key={`${issue.code}:${index}`}>{issue.message}<span className="block break-all text-[11px] opacity-80">{issue.code}</span></li>)}</ul> : null;
}

function applicationLabel(application: Revision["applications"][number], source: Revision["source"]): string {
  if (application.evidenceState === "review_required") return application.status === "retry_required" ? "Retry required" : "Review required";
  if (application.status !== "applied") return formatWorkspaceStatus(application.status);
  if (application.outcome?.lotsUpdated === 0) return "Processed · no lots changed";
  return source?.evidence === "estimated" ? "Estimate applied to captured lots" : "Applied to captured lots";
}

function RevisionDetails({ revision, navigation }: { revision: Revision; navigation: ProcurementNavigation }) {
  const source = revision.source;
  return <details className="rounded-lg border p-3" data-testid={`cost-revision-${revision.id}`} open={revision.latestRecordedSourceRevision}>
    <summary className="cursor-pointer text-sm font-medium"><span className="break-words">{formatWorkspaceStatus(revision.component)} · PO line #{revision.purchaseOrderLineId}{revision.shipmentLineId ? ` · Shipment line #${revision.shipmentLineId}` : ""}</span><span className="mt-1 block text-xs font-normal text-muted-foreground">Revision {revision.revision} · {revision.latestRecordedSourceRevision ? "Latest recorded source" : "Historical source"} · {source ? formatWorkspaceStatus(source.evidence) : "Source requires review"}</span></summary>
    <div className="mt-3 space-y-3">
      <p className="break-words font-mono text-sm">{formatWorkspaceMills(source?.totalMills ?? null, source?.currency ?? null)}{source?.basePieces ? ` across ${source.basePieces.toLocaleString()} base pieces` : " · Quantity basis unknown"}</p>
      <p className="text-xs text-muted-foreground">Source #{revision.id} · {formatWorkspaceDate(revision.recordedAt)} · Recorded by {revision.recordedBy}. Packaging: {source ? formatWorkspaceStatus(source.packagingTreatment) : "Unknown"}.</p>
      {source && <div className="flex flex-wrap gap-2">{source.sources.map((reference) => {
        const kind = reference.kind === "purchase_order_line" ? "purchase" : reference.kind === "vendor_invoice_line" ? "invoice" : reference.kind === "shipment_cost" ? "shipment" : null;
        const label = `${formatWorkspaceStatus(reference.kind)} #${reference.lineId}`;
        return kind ? <Link key={`${reference.kind}:${reference.lineId}`} href={navigation.inspectHref({ kind, id: reference.documentId })} className="break-words text-xs text-primary underline underline-offset-4">{label}</Link> : <span key={`${reference.kind}:${reference.lineId}`} className="text-xs">{label} · Document #{reference.documentId}</span>;
      })}</div>}
      {source?.manualOverride && <p className="text-xs">Manual source review: {source.manualOverride.reason} · {source.manualOverride.actorId} · {formatWorkspaceDate(source.manualOverride.recordedAt)}</p>}
      <EvidenceIssues issues={revision.issues} />
      {revision.applications.length === 0 ? <p className="rounded-md bg-muted/40 p-3 text-xs">No application has been recorded for this source revision.</p> : revision.applications.map((application) => <details key={application.id} id={`cost-application-${application.id}`} className="rounded-md bg-muted/30 p-3" data-testid={`cost-application-${application.id}`}>
        <summary className="cursor-pointer text-xs font-semibold">{applicationLabel(application, source)} · Application #{application.id}<span className="mt-1 block font-normal text-muted-foreground">{formatWorkspaceDate(application.recordedAt)}{application.latestRecordedApplication ? " · Latest attempt for this revision" : " · Historical attempt"}</span></summary>
        <div className="mt-3 space-y-3">
          <p className="text-xs text-muted-foreground">Recorded by {application.recordedBy}. These snapshots describe the lots captured by this application.</p>
          {application.outcome && <dl className="grid grid-cols-2 gap-3 text-xs"><div><dt className="text-muted-foreground">Lots updated</dt><dd>{application.outcome.lotsUpdated.toLocaleString()}</dd></div><div><dt className="text-muted-foreground">Sold-cost rows updated</dt><dd>{application.outcome.cogsRowsUpdated.toLocaleString()}</dd></div><div className="col-span-2"><dt className="text-muted-foreground">Recorded COGS adjustment</dt><dd className="break-words font-mono">{formatWorkspaceMoney(application.outcome.totalCogsDeltaCents, source?.currency ?? null)}</dd></div></dl>}
          <EvidenceIssues issues={application.issues} />
          {application.reportingEvent && <p className="rounded-md border p-2 text-xs">Internal reporting event #{application.reportingEvent.id} · {formatWorkspaceDate(application.reportingEvent.recordedAt)} · {application.reportingEvent.evidenceState === "verified_record" ? "Recorded" : "Needs review"}. Delivery to Archon or another external system is not verified.</p>}
          {application.lotChanges.map((change) => <details key={change.lotId} className="rounded-md border p-2">
            <summary className="cursor-pointer text-xs font-medium">{change.lotNumber ?? `Lot #${change.lotId}`} · {formatWorkspaceStatus(change.lineage)}<span className="mt-1 block font-normal text-muted-foreground">Lot #{change.lotId} · Variant #{change.variantId ?? "unknown"} · Current location #{change.locationId ?? "unknown"}</span></summary>
            <div className="mt-2 space-y-3">
              <p className="text-xs">Current on-hand: {change.currentOnHandUnits?.toLocaleString() ?? "Unknown"} variant units.{change.receivingLineId ? ` Origin: receipt line #${change.receivingLineId}, PO line #${change.originalPurchaseOrderLineId}.` : ""}</p>
              {change.before && change.after && <div className="space-y-1 text-xs">{(["productMills", "packagingMills", "landedMills"] as const).map((component) => <p key={component} className="break-words"><span className="font-medium">{component === "productMills" ? "Product" : component === "packagingMills" ? "Packaging" : "Landed"} / variant:</span> <span className="font-mono">{formatWorkspaceMills(change.before![component], source?.currency ?? null)} → {formatWorkspaceMills(change.after![component], source?.currency ?? null)}</span></p>)}<p className="break-words text-muted-foreground">Captured allocation: {formatWorkspaceMills(change.after.allocatedMills, source?.currency ?? null)} across {change.after.quantity.toLocaleString()} units; exact remainder {formatWorkspaceMills(change.after.remainderMills, source?.currency ?? null)}.</p></div>}
              {change.contributions.length > 0 && <ul className="space-y-1 text-xs">{change.contributions.map((edge) => <li key={edge.id} className="break-words">Contribution #{edge.id}: source lot #{edge.sourceLotId}, {edge.sourceQty.toLocaleString()} source units into {edge.outputQty.toLocaleString()} operation output units · Output interval starts at {edge.outputStartQty.toLocaleString()} · {formatWorkspaceStatus(edge.operationKind)}<span className="block break-all text-muted-foreground">{edge.operationKey}</span></li>)}</ul>}
              <EvidenceIssues issues={change.issues} />
            </div>
          </details>)}
        </div>
      </details>)}
      <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Source fingerprint</summary><p className="mt-2 break-all font-mono">{revision.fingerprint}</p></details>
    </div>
  </details>;
}

export function PurchaseCostApplications({ history, data, navigation }: { history: PurchaseCostApplicationHistory; data: PurchaseWorkspace; navigation: ProcurementNavigation }) {
  return <section className="space-y-2" aria-label="Recorded cost applications"><h4 className="text-sm font-semibold">Source revisions and cost applications</h4><p className="text-xs text-muted-foreground">Compare each recorded source with its inventory and sold-cost outcomes. Newer receipts or source changes can require another application.</p>{history.revisions.length === 0 ? <p className="text-xs text-muted-foreground">No immutable cost source revision is recorded for {data.purchase.poNumber}. Historical source amounts remain available below.</p> : history.revisions.map((revision) => <RevisionDetails key={revision.id} revision={revision} navigation={navigation} />)}</section>;
}

export function PurchaseReceiptCostQueue({ requests, data, navigation, actions }: { requests: ReceiptCostRequestHistory; data: PurchaseWorkspace; navigation: ProcurementNavigation; actions?: ReceiptCostActions }) {
  return <section className="space-y-2" aria-label="Receipt cost processing"><h4 className="text-sm font-semibold">Receipt cost processing</h4>{actions?.error && <p role="alert" className="rounded-md border border-destructive/30 p-3 text-xs">{actions.error} The physical receipt is separate; refresh to check the recorded cost outcome.</p>}{actions?.message && <p role="status" className="rounded-md border p-3 text-xs">{actions.message}</p>}{requests.length === 0 ? <p className="text-xs text-muted-foreground">No durable receipt cost requests are recorded for this purchase. This does not establish that historical costs were processed.</p> : requests.map((request) => {
    const receipt = data.receipts.find((row) => row.id === request.receiptId);
    return <div key={request.id} className="space-y-2 rounded-lg border p-3" data-testid={`receipt-cost-request-${request.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2"><Link href={navigation.inspectHref({ kind: "receipt", id: request.receiptId })} className="text-xs font-semibold text-primary underline underline-offset-4">{receipt?.receiptNumber ?? `Receipt #${request.receiptId}`}</Link><Badge variant="outline">{request.state === "pending" ? "Costs queued" : request.state === "applied" ? "Receipt cost attempt completed" : formatWorkspaceStatus(request.state)}</Badge></div>
      <p className="text-xs">PO line #{request.purchaseOrderLineId} · Request #{request.id} · Physical receipt: {formatWorkspaceStatus(request.receiptStatus)}.</p>
      <p className="text-xs text-muted-foreground">Requested {formatWorkspaceDate(request.requestedAt)} by {request.requestedBy}.{request.state === "applied" ? " Later source revisions are tracked separately above." : request.receiptStatus === "closed" ? " The stock receipt remains recorded while its costs are processed." : ""}</p>
      {request.attempts[0] && <EvidenceIssues issues={request.attempts[0].issues} />}
      {request.state !== "applied" && request.receiptStatus === "closed" && actions?.canRetry && <Button size="sm" variant="outline" disabled={actions.pendingReceiptId !== null} onClick={() => actions.onRetry(request.receiptId)}>{actions.pendingReceiptId === request.receiptId ? "Processing costs…" : "Retry receipt costs"}</Button>}
      {request.attempts.length > 0 && <details className="text-xs"><summary className="cursor-pointer font-medium">{request.attempts.length} recorded cost {request.attempts.length === 1 ? "attempt" : "attempts"}</summary><div className="mt-2 space-y-3">{request.attempts.map((attempt) => <div key={attempt.id} className="space-y-1 border-t pt-2"><p>Attempt #{attempt.id} · {formatWorkspaceStatus(attempt.state)} · {formatWorkspaceDate(attempt.recordedAt)} · {attempt.recordedBy}</p>{attempt.applicationIds.length > 0 && <p>Applications: {attempt.applicationIds.map((id) => `#${id}`).join(", ")}</p>}<EvidenceIssues issues={attempt.issues} /></div>)}</div></details>}
    </div>;
  })}</section>;
}
