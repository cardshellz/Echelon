import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { purchaseTaxTypeSchema, purchaseTaxTreatmentLabel } from "@shared/procurement/purchase-tax";
import { financialCommandFetchJson } from "@/lib/financial-command";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { useAuth } from "@/lib/auth";
import { PurchaseTaxReview } from "./PurchaseTaxReview";

export function usePurchaseTaxTypes(enabled = true) {
  return useQuery({ queryKey: ["/api/purchasing/tax-types"], enabled,
    queryFn: async () => z.array(purchaseTaxTypeSchema).parse(await financialCommandFetchJson("/api/purchasing/tax-types", { method: "GET" })) });
}

export function PurchaseTaxTypesSettings() {
  const { hasPermission } = useAuth();
  const allowed = hasPermission("purchasing", "view"), types = usePurchaseTaxTypes(allowed);
  if (!allowed) return null;
  return <Card><CardHeader><CardTitle>Purchase tax types</CardTitle><CardDescription>Set each tax treatment once. Purchases, supplier invoices, shipment charges and receiving use the saved rule. Changing it requires administrator approval of the cost changes.</CardDescription></CardHeader>
    <CardContent className="space-y-3">{types.isPending && <p>Loading tax types…</p>}{types.error && <p role="alert">{types.error.message}</p>}
      {types.data?.map(type => <div key={type.id} className="flex flex-wrap items-center justify-between gap-3 rounded border p-3"><div><strong>{type.name}</strong><p className="text-sm text-muted-foreground">{type.code} · {purchaseTaxTreatmentLabel(type.treatment)}</p></div><PurchaseTaxReview target={{ kind: "tax_type", id: type.id }} label={`Review ${type.name}`} /></div>)}
      {types.data?.length === 0 && <p className="text-sm text-muted-foreground">No tax treatments are assumed. Add the tax types used on your supplier documents.</p>}
      <PurchaseTaxReview target={{ kind: "tax_type", id: null }} label="Add tax type" />
    </CardContent></Card>;
}
