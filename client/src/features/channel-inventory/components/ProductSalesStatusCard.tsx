import { useState } from "react";
import { Link } from "wouter";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/lib/auth";

import { SalesStatusPanel } from "./SalesStatusPanel";

/**
 * The product page's channel section after inventory cutover: the all-channels
 * sales status for the product and each SKU (replacing the retired legacy
 * per-product allocation). Stock rules (share, buffer, limits) stay in
 * Channel Inventory.
 */
export function ProductSalesStatusCard({ productId }: { productId: number }) {
  const { hasPermission } = useAuth();
  const [focusVariantId, setFocusVariantId] = useState<number | null>(null);
  return (
    <Card data-testid="product-sales-status">
      <CardHeader className="p-3 md:p-6">
        <CardTitle className="text-base md:text-lg">Sales status</CardTitle>
        <CardDescription className="text-xs md:text-sm">
          Stop or resume selling this product or any of its SKUs on every channel at once, with per-channel
          exceptions. Share, buffer and publish limits are stock rules in Channel Inventory.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 p-3 pt-0 md:p-6 md:pt-0">
        {hasPermission("inventory_planning", "view") ? (
          <SalesStatusPanel
            key={focusVariantId ?? "product"}
            productId={productId}
            productVariantId={focusVariantId}
            canChange={hasPermission("inventory_planning", "activate")}
            onFocusVariant={setFocusVariantId}
          />
        ) : (
          <p className="text-sm text-muted-foreground">Seeing sales status needs inventory planning view permission.</p>
        )}
        <Button asChild variant="outline" size="sm">
          <Link href={`/channels/inventory?product=${productId}&tab=rules`}>Open stock rules in Channel Inventory</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
