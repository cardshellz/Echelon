import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { PackageX, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
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

interface UnassignedItem {
  levelId: number;
  variantId: number;
  sku: string;
  name: string;
  variantQty: number;
  locationId: number;
  locationCode: string;
  locationType: string;
}

interface UnassignedSectionProps {
  canEdit: boolean;
  onTransfer: (fromLocationId: number, fromLocationCode: string, variantId: number, sku: string) => void;
}

export default function UnassignedSection({ canEdit, onTransfer }: UnassignedSectionProps) {
  const [isOpen, setIsOpen] = useState(false);

  const { data: items, isLoading } = useQuery<UnassignedItem[]>({
    queryKey: ["/api/operations/unassigned-inventory"],
    queryFn: async () => {
      const res = await fetch("/api/operations/unassigned-inventory");
      if (!res.ok) throw new Error("Failed to fetch unassigned inventory");
      return res.json();
    },
    staleTime: 30_000,
  });

  const count = items?.length ?? 0;

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div className="rounded-lg border bg-card">
        <CollapsibleTrigger className="flex items-center justify-between w-full p-4 hover:bg-muted/30">
          <div className="flex items-center gap-2">
            <PackageX className="h-4 w-4 text-muted-foreground" />
            <h3 className="font-semibold text-base">Unassigned Inventory</h3>
            {count > 0 && (
              <Badge variant="secondary" className="text-xs">{count}</Badge>
            )}
          </div>
          {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t">
            {isLoading ? (
              <div className="text-sm text-muted-foreground py-6 text-center">Loading...</div>
            ) : count === 0 ? (
              <div className="text-sm text-muted-foreground py-6 text-center">
                No unassigned inventory (receiving/staging areas are empty)
              </div>
            ) : (
              <>
                {/* Desktop */}
                <div className="hidden md:block">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>SKU</TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead>Location</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead className="text-right">Qty</TableHead>
                        {canEdit && <TableHead className="w-[100px]"></TableHead>}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {items!.map((item) => (
                        <TableRow key={item.levelId}>
                          <TableCell className="font-mono text-sm">{item.sku}</TableCell>
                          <TableCell className="text-sm text-muted-foreground truncate max-w-[200px]">{item.name}</TableCell>
                          <TableCell className="font-mono text-sm">{item.locationCode}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className="text-[10px] bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
                              {item.locationType.replace("_", " ")}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right font-mono font-medium">{item.variantQty.toLocaleString()}</TableCell>
                          {canEdit && (
                            <TableCell>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 text-xs"
                                onClick={() => onTransfer(item.locationId, item.locationCode, item.variantId, item.sku)}
                              >
                                <ArrowRight className="h-3.5 w-3.5 mr-1" />
                                Move to Bin
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
                  {items!.map((item) => (
                    <div key={item.levelId} className="rounded-md border p-3">
                      <div className="flex justify-between">
                        <div>
                          <div className="font-mono text-sm font-medium">{item.sku}</div>
                          <div className="text-xs text-muted-foreground">{item.name}</div>
                        </div>
                        <div className="text-right">
                          <div className="font-mono font-bold">{item.variantQty}</div>
                          <Badge variant="outline" className="text-[10px]">{item.locationCode}</Badge>
                        </div>
                      </div>
                      {canEdit && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full mt-2 h-7 text-xs"
                          onClick={() => onTransfer(item.locationId, item.locationCode, item.variantId, item.sku)}
                        >
                          Move to Bin
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
