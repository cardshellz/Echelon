import React, { type ReactNode } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { procurementListChildHref } from "@/lib/procurement-navigation";

export interface SupplierReturnContext {
  vendorId?: number;
  purchaseOrderId?: number;
  receivingOrderId?: number;
  create?: boolean;
}
/** Context narrows discovery. The server still proves every physical source. */
export function supplierReturnHref(context: SupplierReturnContext, path = "", search = ""): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(context)) {
    if (key === "create") { if (value) params.set("new", "1"); }
    else if (typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647) params.set(key, String(value));
  }
  return procurementListChildHref(path, search, `/supplier-returns${params.size ? `?${params}` : ""}`);
}
export function SupplierReturnLink({ children = "Supplier returns", ...context }: SupplierReturnContext & { children?: ReactNode }) {
  const [path] = useLocation();
  const search = useSearch();
  return <Link className="text-sm text-primary underline underline-offset-4" href={supplierReturnHref(context, path, search)}>{children}</Link>;
}
