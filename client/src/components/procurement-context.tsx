import React from "react";
import { Link } from "wouter";
import { CornerUpLeft } from "lucide-react";
import type { ProcurementNavigation } from "@/hooks/use-procurement-navigation";

export function ProcurementContext({ navigation }: { navigation: ProcurementNavigation }) {
  if (!navigation.purchaseHref) return null;
  return (
    <nav aria-label="Purchase context" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-muted/40 px-3 py-2 text-sm">
      <span className="text-muted-foreground">Following purchase #{navigation.purchaseId}</span>
      <Link href={navigation.purchaseHref} className="inline-flex items-center gap-1 rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <CornerUpLeft className="h-4 w-4" aria-hidden="true" />
        Back to purchase #{navigation.purchaseId}
      </Link>
    </nav>
  );
}
