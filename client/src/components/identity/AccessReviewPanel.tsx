import React from "react";
import { describeStaffWorkflows, staffCapabilityLabel, type AccessReview } from "@shared/staff-capabilities";

export function AccessReviewPanel({ review }: { review: AccessReview }) {
  return <section aria-label="Access impact review" className="space-y-3 rounded border p-3" data-testid="access-impact-review">
    <p>{review.affectedCount} account{review.affectedCount === 1 ? "" : "s"} affected. Roles combine their grants; a restriction is not a deny over another role.</p>
    <p className="text-sm text-muted-foreground">Journey preview covers shipments and access administration. Other areas retain their existing controls.</p>
    {review.dependencies.length > 0 && <p role="alert">Missing prerequisites: {review.dependencies.map(item => `${staffCapabilityLabel(item.capability)} requires ${staffCapabilityLabel(item.required)}`).join("; ")}. No prerequisite is granted automatically.</p>}
    {review.blockingDependencies.length > 0 && <p role="alert">This change creates incomplete access. Resolve its prerequisites before saving.</p>}
    {review.users.map(({ before, after }) => {
      const workflows = describeStaffWorkflows(after.permissions);
      const gained = after.permissions.filter(key => !before.permissions.includes(key));
      const lost = before.permissions.filter(key => !after.permissions.includes(key));
      return <div key={after.userId} className="rounded border p-2 space-y-1">
        <h3 className="font-medium">{after.label ?? "Affected account"}{!after.active ? " (inactive)" : ""}</h3>
        <p className="text-sm">Added: {gained.map(staffCapabilityLabel).join(", ") || "none"}. Removed: {lost.map(staffCapabilityLabel).join(", ") || "none"}.</p>
        {after.roleIds.length === 0 && <p className="text-sm">No roles: no operational access.</p>}
        <ul className="text-sm">{workflows.map(workflow => <li key={workflow.id}>
          {workflow.label}: {workflow.available ? "available" : `unavailable — needs ${workflow.missing.map(staffCapabilityLabel).join(", ")}`}
        </li>)}</ul>
        <details><summary className="text-sm cursor-pointer">Why this access?</summary>
          <ul className="text-sm">{after.sources.map(source => <li key={`${source.roleId}:${source.permission}`}>
            {staffCapabilityLabel(source.permission)} from {source.roleName ?? `role #${source.roleId}`}{source.restricted ? " — restricted; not a global grant" : ""}
          </li>)}</ul>
        </details>
      </div>;
    })}
  </section>;
}
