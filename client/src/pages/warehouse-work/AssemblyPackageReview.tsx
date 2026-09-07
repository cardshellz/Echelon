import React from "react";
import { useQuery } from "@tanstack/react-query";
import { assemblyPackageReviewSchema, type AssemblyPackageReview as Review } from "@shared/assembly-package-review";
import { Button } from "@/components/ui/button";
import { assemblyRequest } from "./assembly-api";

const issueText: Record<string, string> = {
  label_not_active: "This label is not active. Do not apply it.",
  label_evidence_unusable: "The stored label evidence could not be verified.",
  contents_not_proven: "Exact package contents have not arrived or are incomplete.",
  provider_evidence_requires_review: "The provider evidence conflicts or needs review.",
  carrier_possession_already_reported: "Carrier possession has already been reported; review this job before proceeding.",
  package_contains_sources_outside_this_order: "This package includes shipment sources outside this order; combined-package review is required.",
  source_shipment_not_open: "A source shipment is no longer open.",
  declared_quantity_exceeds_source: "The label reports more units than its source shipment authorizes.",
};

export function AssemblyPackageEvidence({ review }: { review: Review }) {
  return <div className="space-y-3">
    <p className="text-sm">These are observed provider contents, not a packed/shipped receipt or proof that all packages were discovered. Confirming package close is not connected yet.</p>
    {review.packages.length === 0 && <p role="status">No linked package label is available yet. Keep the existing label and work together; refresh after label data arrives. Do not create another label from this screen.</p>}
    {review.packages.map((pkg) => <section key={pkg.labelId} className="rounded border p-3 space-y-2" aria-label={`Package label ${pkg.labelId}`}>
      <p className="font-medium">{pkg.provider} · label {pkg.labelId} · {pkg.labelStatus}</p>
      <p>Tracking: <span className="font-mono">{pkg.trackingNumber}</span></p>
      {pkg.status === "review_required" ? <ul className="list-disc pl-5 text-sm" role="status">
        {pkg.issues.map((issue) => <li key={issue}>{issueText[issue] ?? `Package review required: ${issue}`}</li>)}
      </ul> : <><p className="text-sm">Provider-declared contents:</p><ul className="list-disc pl-5">
        {pkg.items.map((item) => <li key={item.sourceShipmentItemId}>{item.quantity} × {item.sku}</li>)}
      </ul></>}
    </section>)}
  </div>;
}

export function AssemblyPackageReview({ taskId, actorId }: { taskId: string; actorId: string }) {
  const query = useQuery({ queryKey: ["assembly", "package-review", taskId, actorId],
    queryFn: () => assemblyRequest(`/api/warehouse/assembly-work/${taskId}/packages`, assemblyPackageReviewSchema),
    retry: false, refetchInterval: 15000 });
  return <section className="space-y-3 border-t pt-3" aria-label="Preprinted package label review">
    <h3 className="font-semibold">Preprinted label and package contents</h3>
    {query.isPending && <p>Loading observed package evidence…</p>}
    {query.error ? <p role="alert">{query.error.message}</p> : query.data && <AssemblyPackageEvidence review={query.data} />}
    <Button variant="outline" disabled={query.isFetching} onClick={() => query.refetch()}>Refresh package evidence</Button>
  </section>;
}
