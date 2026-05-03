import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Boxes, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  buildQueryUrl,
  fetchJson,
  formatStatus,
  type DropshipCatalogResponse,
  type DropshipCatalogRow,
} from "@/lib/dropship-ops-surface";
import { DropshipPortalShell } from "./DropshipPortalShell";

export default function DropshipPortalCatalog() {
  const [search, setSearch] = useState("");
  const [selectedOnly, setSelectedOnly] = useState("false");
  const [applied, setApplied] = useState({ search: "", selectedOnly: "false" });
  const catalogUrl = useMemo(() => buildQueryUrl("/api/dropship/catalog", {
    search: applied.search,
    selectedOnly: applied.selectedOnly,
    page: 1,
    limit: 50,
  }), [applied]);
  const catalogQuery = useQuery<DropshipCatalogResponse>({
    queryKey: [catalogUrl],
    queryFn: () => fetchJson<DropshipCatalogResponse>(catalogUrl),
  });

  return (
    <DropshipPortalShell>
      <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold">
              <Boxes className="h-6 w-6 text-[#C060E0]" />
              Catalog
            </h1>
            <p className="mt-1 text-sm text-zinc-500">Exposed Card Shellz dropship products and your selection state.</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative min-w-0 sm:w-80">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} className="pl-9" placeholder="Search catalog" />
            </div>
            <Select value={selectedOnly} onValueChange={setSelectedOnly}>
              <SelectTrigger className="sm:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="false">All exposed</SelectItem>
                <SelectItem value="true">Selected only</SelectItem>
              </SelectContent>
            </Select>
            <Button className="bg-[#C060E0] hover:bg-[#a94bc9]" onClick={() => setApplied({ search, selectedOnly })}>
              Apply
            </Button>
          </div>
        </div>

        <div className="mt-5 rounded-md border border-zinc-200 bg-white">
          {catalogQuery.isLoading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : catalogQuery.data?.rows.length ? (
            <CatalogTable rows={catalogQuery.data.rows} total={catalogQuery.data.total} />
          ) : (
            <Empty className="p-8">
              <EmptyMedia variant="icon"><Boxes /></EmptyMedia>
              <EmptyHeader>
                <EmptyTitle>No catalog rows</EmptyTitle>
                <EmptyDescription>No exposed catalog rows match the current filters.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
      </div>
    </DropshipPortalShell>
  );
}

function CatalogTable({ rows, total }: { rows: DropshipCatalogRow[]; total: number }) {
  return (
    <>
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 text-sm text-zinc-500">
        <span>{total} row{total === 1 ? "" : "s"}</span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Product</TableHead>
            <TableHead>Variant</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Quantity</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.productVariantId}>
              <TableCell>
                <div className="font-medium">{row.productName}</div>
                <div className="text-xs text-zinc-500">{row.productSku || "No product SKU"}</div>
              </TableCell>
              <TableCell>
                <div className="font-medium">{row.variantName}</div>
                <div className="text-xs text-zinc-500">{row.variantSku || `Variant ${row.productVariantId}`}</div>
              </TableCell>
              <TableCell>
                <div>{row.category ? formatStatus(row.category) : "Uncategorized"}</div>
                {row.productLineNames.length > 0 && (
                  <div className="text-xs text-zinc-500">{row.productLineNames.join(", ")}</div>
                )}
              </TableCell>
              <TableCell className="font-mono">{row.selectionDecision.marketplaceQuantity}</TableCell>
              <TableCell>
                <Badge
                  variant="outline"
                  className={row.selectionDecision.selected
                    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                    : "border-zinc-200 bg-zinc-50 text-zinc-600"}
                >
                  {row.selectionDecision.selected ? "Selected" : formatStatus(row.selectionDecision.reason)}
                </Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}
