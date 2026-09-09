import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  supplierProgressHistorySchema,
  type SupplierProgressReport,
} from "@shared/procurement/purchase-pipeline";
import { Button } from "@/components/ui/button";
import { formatPipelinePieces } from "./purchase-pipeline-presentation";

function ReportValues({ report }: { report: SupplierProgressReport }) {
  return (
    <div className="space-y-1">
      <p className="font-medium">{report.reference}</p>
      <p>
        {formatPipelinePieces(String(report.startedPieces))} pieces started /{" "}
        {formatPipelinePieces(String(report.completedPieces))} pieces completed
      </p>
      <p className="text-muted-foreground">
        Report as of <time dateTime={report.asOf}>{report.asOf}</time>
      </p>
      {report.notes && <p className="whitespace-pre-wrap">{report.notes}</p>}
    </div>
  );
}

export function SupplierReportHistory({
  purchaseOrderLineId,
}: {
  purchaseOrderLineId: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const validLineId =
    supplierProgressHistorySchema.shape.purchaseOrderLineId.safeParse(
      purchaseOrderLineId,
    ).success;
  const history = useQuery({
    queryKey: ["supplier-progress-history", purchaseOrderLineId],
    enabled: expanded && validLineId,
    retry: false,
    queryFn: async ({ signal }) => {
      const lineId =
        supplierProgressHistorySchema.shape.purchaseOrderLineId.parse(
          purchaseOrderLineId,
        );
      const response = await fetch(
        `/api/purchasing/pipeline/lines/${lineId}/progress`,
        { method: "GET", credentials: "include", signal },
      );
      if (!response.ok)
        throw new Error("Supplier report history could not be loaded.");
      const parsed = supplierProgressHistorySchema.parse(await response.json());
      if (parsed.purchaseOrderLineId !== lineId)
        throw new Error("Supplier report history belongs to a different line.");
      return parsed;
    },
  });

  return (
    <details
      className="text-xs"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="w-fit cursor-pointer font-medium text-muted-foreground hover:text-foreground">
        Supplier report history
      </summary>
      {expanded && (
        <div className="mt-2 space-y-3">
          {!validLineId ? (
            <p role="alert">
              Supplier report history needs a valid purchase line.
            </p>
          ) : history.isPending ? (
            <p role="status">Loading supplier report history…</p>
          ) : (
            <>
              {history.isError && (
                <div role="alert" className="space-y-1">
                  <p>Supplier report history could not be loaded.</p>
                  {history.data && (
                    <p className="text-muted-foreground">
                      Previously loaded history is shown below.
                    </p>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={history.isFetching}
                    onClick={() => void history.refetch()}
                  >
                    Retry history
                  </Button>
                </div>
              )}
              {history.data && (
                <>
                  {history.data.current.report && (
                    <p className="text-muted-foreground">
                      Current revision {history.data.current.revision}
                    </p>
                  )}
                  {history.data.changes.map((change) => (
                    <div
                      key={change.revision}
                      className="space-y-1 border-t pt-2"
                    >
                      <p className="font-semibold">
                        Revision {change.revision}
                      </p>
                      <ReportValues report={change.after} />
                      <p className="text-muted-foreground">
                        Recorded by {change.recordedBy} ·{" "}
                        <time dateTime={change.recordedAt}>
                          {change.recordedAt}
                        </time>
                      </p>
                    </div>
                  ))}
                  {history.data.changes.length === 0 &&
                    (history.data.current.report ? (
                      <div className="space-y-1 border-t pt-2">
                        <ReportValues report={history.data.current.report} />
                        <p className="text-muted-foreground">
                          Recorded by{" "}
                          {history.data.current.recordedBy ?? "Not recorded"}
                          {history.data.current.recordedAt && (
                            <>
                              {" "}
                              ·{" "}
                              <time dateTime={history.data.current.recordedAt}>
                                {history.data.current.recordedAt}
                              </time>
                            </>
                          )}
                        </p>
                        <p>No earlier report revisions are available.</p>
                      </div>
                    ) : (
                      <p>No supplier report history has been recorded.</p>
                    ))}
                </>
              )}
            </>
          )}
        </div>
      )}
    </details>
  );
}
