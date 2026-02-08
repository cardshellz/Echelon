import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, ArrowLeftRight, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronDown, ChevronRight } from "lucide-react";

interface SkuLocation {
  locationId: number;
  locationCode: string;
  locationType: string;
  zone: string | null;
  warehouseCode: string | null;
  variantQty: number;
  reservedQty: number;
  isPickable: number;
}

interface SkuSearchResult {
  variantId: number;
  sku: string;
  name: string;
  locations: SkuLocation[];
}

interface SkuLocatorSectionProps {
  canEdit: boolean;
  onTransfer: (fromLocationId: number, fromLocationCode: string, variantId: number, sku: string) => void;
}

export default function SkuLocatorSection({ canEdit, onTransfer }: SkuLocatorSectionProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(true);

  const { data: results, isLoading } = useQuery<SkuSearchResult[]>({
    queryKey: ["/api/inventory/sku-locations", query],
    queryFn: async () => {
      const res = await fetch(`/api/inventory/sku-locations?q=${encodeURIComponent(query)}`);
      if (!res.ok) throw new Error("Failed to search SKUs");
      return res.json();
    },
    enabled: query.length >= 2,
  });

  const handleSearch = () => {
    if (searchTerm.trim().length >= 2) setQuery(searchTerm.trim());
  };

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div className="rounded-lg border bg-card">
        <CollapsibleTrigger className="flex items-center justify-between w-full p-4 hover:bg-muted/30">
          <div className="flex items-center gap-2">
            <MapPin className="h-4 w-4 text-muted-foreground" />
            <h3 className="font-semibold text-base">SKU Locator</h3>
          </div>
          {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="px-4 pb-4 space-y-3">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search by SKU or product name..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                  className="pl-9 h-9"
                />
              </div>
              <Button size="sm" className="h-9" onClick={handleSearch} disabled={searchTerm.length < 2}>
                Search
              </Button>
            </div>

            {isLoading && <div className="text-sm text-muted-foreground py-4 text-center">Searching...</div>}

            {results && results.length === 0 && query && (
              <div className="text-sm text-muted-foreground py-4 text-center">No results for "{query}"</div>
            )}

            {results && results.length > 0 && (
              <div className="space-y-3">
                {results.map((result) => (
                  <div key={result.variantId} className="border rounded-md">
                    <div className="p-3 bg-muted/20">
                      <span className="font-mono font-medium text-sm">{result.sku}</span>
                      <span className="text-sm text-muted-foreground ml-2">{result.name}</span>
                    </div>
                    <div className="hidden md:block">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Location</TableHead>
                            <TableHead>Zone</TableHead>
                            <TableHead>Type</TableHead>
                            <TableHead className="text-center">Pickable</TableHead>
                            <TableHead className="text-right">Qty</TableHead>
                            <TableHead className="text-right">Reserved</TableHead>
                            {canEdit && <TableHead className="w-[80px]"></TableHead>}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {result.locations.map((loc) => (
                            <TableRow key={loc.locationId}>
                              <TableCell className="font-mono text-sm">
                                {loc.locationCode}
                                {loc.warehouseCode && (
                                  <span className="ml-1.5 text-xs text-muted-foreground">[{loc.warehouseCode}]</span>
                                )}
                              </TableCell>
                              <TableCell className="text-sm">{loc.zone || "—"}</TableCell>
                              <TableCell>
                                <Badge
                                  variant="outline"
                                  className={`text-[10px] ${
                                    loc.locationType === "forward_pick"
                                      ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"
                                      : loc.locationType === "bulk_storage"
                                      ? "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400"
                                      : "bg-muted"
                                  }`}
                                >
                                  {loc.locationType.replace("_", " ")}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-center">
                                {loc.isPickable ? (
                                  <Badge variant="outline" className="text-[10px] bg-green-100 text-green-800">Yes</Badge>
                                ) : (
                                  <span className="text-xs text-muted-foreground">No</span>
                                )}
                              </TableCell>
                              <TableCell className="text-right font-mono">{loc.variantQty.toLocaleString()}</TableCell>
                              <TableCell className="text-right font-mono text-muted-foreground">
                                {loc.reservedQty > 0 ? loc.reservedQty.toLocaleString() : "—"}
                              </TableCell>
                              {canEdit && (
                                <TableCell>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7"
                                    onClick={() => onTransfer(loc.locationId, loc.locationCode, result.variantId, result.sku)}
                                  >
                                    <ArrowLeftRight className="h-3.5 w-3.5 mr-1" />
                                    Move
                                  </Button>
                                </TableCell>
                              )}
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                    {/* Mobile */}
                    <div className="md:hidden p-3 space-y-2">
                      {result.locations.map((loc) => (
                        <div key={loc.locationId} className="flex items-center justify-between text-sm">
                          <div>
                            <span className="font-mono">{loc.locationCode}</span>
                            <Badge variant="outline" className="text-[10px] ml-1.5">
                              {loc.locationType.replace("_", " ")}
                            </Badge>
                          </div>
                          <span className="font-mono font-medium">{loc.variantQty}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
