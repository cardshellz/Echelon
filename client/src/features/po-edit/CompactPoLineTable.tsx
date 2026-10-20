import React, { type ComponentProps } from "react";
import { Table } from "@/components/ui/table";

/** Shared compact table frame for draft lines and approved-document amendments. */
export function CompactPoLineTable(props: ComponentProps<typeof Table>) {
  return <div className="min-w-0 overflow-hidden rounded-lg border border-slate-200 shadow-sm"><Table {...props} /></div>;
}
