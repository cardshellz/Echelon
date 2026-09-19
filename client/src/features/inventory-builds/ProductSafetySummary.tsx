import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { promiseSafetyAdminViewSchema } from "@shared/types/inventory-promise-safety-admin";
import { useAuth } from "@/lib/auth";
import { fetchJson } from "@/pages/inventory-planning-http";
import { formatPromiseSafetyPolicy } from "@/pages/promise-safety-policy-model";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function ProductSafetySummary({ productId }: { productId: number }) {
  const { hasPermission } = useAuth();
  if (!hasPermission("inventory_planning", "view")) return null;
  return <AuthorizedSafetySummary productId={productId} />;
}
function AuthorizedSafetySummary({ productId }: { productId: number }) {
  const query = useQuery({ queryKey: ["/api/inventory-planning/admin/promise-safety", productId],
    queryFn: ({ signal }) => fetchJson(`/api/inventory-planning/admin/promise-safety/${productId}`, promiseSafetyAdminViewSchema, { signal }), retry: false });
  return <Card className="mt-4"><CardHeader><CardTitle>Promise safety stock</CardTitle></CardHeader>
    <CardContent className="space-y-3 text-sm">
      <p>Read-only policy definitions. Warehouse/SKU overrides SKU, then the business default. Edit these in Procurement; no separate Inventory setting.</p>
      {query.isError ? <p role="alert">Safety policy unavailable. <button className="underline" onClick={() => query.refetch()}>Retry</button></p>
        : !query.data ? <p>Loading safety policy…</p> : <>
          {query.data.policyHeads.length === 0 && <p>No explicit safety policy is recorded.</p>}
          <ul className="space-y-2">{query.data.policyHeads.map(head => <li key={head.scopeKey}>
            <span className="font-medium">{head.scopeKey}</span>: {head.activePolicy?.lifecycleStatus === "sealed"
              ? formatPromiseSafetyPolicy(head.activePolicy.value) : "No sealed policy"}
            {head.draftPolicy && <span className="text-muted-foreground"> · Draft changes in Procurement—not active</span>}
          </li>)}</ul>
        </>}
      <Link className="underline" href={`/settings/procurement/promise-safety?productId=${productId}`}>Edit in Procurement</Link>
    </CardContent>
  </Card>;
}
