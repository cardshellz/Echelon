import React from "react";
import type { LandedCostHealth } from "@shared/procurement/landed-cost-health";

/** Dashboard and shipment list display the same tasks as the document review.
 * Old servers can still send the original summary during a rolling release. */
export function CostReviewTaskSummary({ item }: { item: LandedCostHealth["items"][number] }) {
  if (!item.tasks?.length) return <span>{item.detail}</span>;
  return <div className="space-y-1">{item.tasks.slice(0, 3).map(task => <p key={task.id}><strong>{task.sku ?? "Product"}: {task.title}.</strong> {task.explanation}</p>)}
    {item.tasks.length > 3 && <p>{item.tasks.length - 3} more items in this shipment's cost review.</p>}
  </div>;
}
