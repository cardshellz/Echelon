import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw, ArrowLeftRight, Edit } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronDown, ChevronRight } from "lucide-react";

interface PickReadinessItem {
  locationId: number;
  locationCode: string;
  variantId: number;
  sku: string;
  name: string;
  currentQty: number;
  bulkAvailable: number;
  pendingReplenTaskId: number | null;
  pendingReplenStatus: string | null;
}

interface PickReadinessSectionProps {
  warehouseId: number | null;
  canEdit: boolean;
  onTransfer: (fromLocationId: number, fromLocationCode: string, variantId: number, sku: string) => void;
  onAdjust: (locationId: number, locationCode: string, variantId: number, sku: string, currentQty: number) => void;
}

export default function PickReadinessSection({ warehouseId, canEdit, onTransfer, onAdjust }: PickReadinessSectionProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [threshold, setThreshold] = useState("5");

  const { data: items, isLoading } = useQuery<PickReadinessItem[]>({
    queryKey: ["/api/operations/pick-readiness", warehouseId, threshold],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (warehouseId) params.set("warehouseId", warehouseId.toString());
      params.set("threshold", threshold);
      const res = await fetch(`/api/operations/pick-readiness?${params}`);
      if (!res.ok) throw new Error("Failed to fetch pick readiness");
      return res.json();
    },
    staleTime: 30_000,
  });

  const count = items?.length ?? 0;

  const replenStatusBadge = (status: string | null) => {
    if (!status) return null;
    const colors: Record<string, string> = {
      pending: "bg-yellow-100 text-yellow-800",
      assigned: "bg-blue-100 text-blue-800",
      in_progress: "bg-purple-100 text-purple-800",
    };
    return (
      <Badge variant="outline" className={`text-[10px] ${colors[status] || ""}`}>
        <RefreshCw className="h-3 w-3 mr-1" />
        {status.replace("_", " ")}
      </Badge>
    );
  };

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div className="rounded-lg border bg-card">
        <CollapsibleTrigger className="flex items-center justify-between w-full p-4 hover:bg-muted/30">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            <h3 className="font-semibold text-base">Pick Readiness</h3>
            {count > 0 && (
              <Badge variant="secondary" className="text-xs bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
                {count} low
              </Badge>
            )}
          </div>
          {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t">
            <div className="p-3 pb-0 flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Threshold:</span>
              <Select value={threshold} onValueChange={setThreshold}>
                <SelectTrigger className="w-[100px] h-7 text-xs" onClick={(e) => e.stopPropagation()}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="3">&le; 3 units</SelectItem>
                  <SelectItem value="5">&le; 5 units</SelectItem>
                  <SelectItem value="10">&le; 10 units</SelectItem>
                  <SelectItem value="20">&le; 20 units</SelectItem>
                  <SelectItem value="50">&le; 50 units</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {isLoading ? (
              <div className="text-sm text-muted-foreground py-6 text-center">Loading...</div>
            ) : count === 0 ? (
              <div className="text-sm text-green-600 py-6 text-center">
                All pick locations are stocked above threshold
              </div>
            ) : (
              <>
                <div className="hidden md:block">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Pick Bin</TableHead>
                        <TableHead>SKU</TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead className="text-right">Current Qty</TableHead>
                        <TableHead className="text-right">Bulk Available</TableHead>
                        <TableHead>Replen Status</TableHead>
                        {canEdit && <TableHead className="w-[100px]"></TableHead>}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {items!.map((item) => (
                        <TableRow key={`${item.locationId}-${item.variantId}`}>
                          <TableCell className="font-mono text-sm">{item.locationCode}</TableCell>
                          <TableCell className="font-mono text-sm">{item.sku}</TableCell>
                          <TableCell className="text-sm text-muted-foreground truncate max-w-[200px]">{item.name}</TableCell>
                          <TableCell className="text-right">
                            <span className={`font-mono font-medium ${item.currentQty === 0 ? "text-red-600" : "text-amber-600"}`}>
                              {item.currentQty}
                            </span>
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {item.bulkAvailable > 0 ? (
                              <span className="text-blue-600">{item.bulkAvailable.toLocaleString()}</span>
                            ) : (
                              <span className="text-red-600">0</span>
                            )}
                          </TableCell>
                          <TableCell>
                            {item.pendingReplenStatus ? (
                              replenStatusBadge(item.pendingReplenStatus)
                            ) : item.bulkAvailable > 0 ? (
                              <span className="text-xs text-muted-foreground">No task</span>
                            ) : (
                              <span className="text-xs text-red-600">No bulk supply</span>
                            )}
                          </TableCell>
                          {canEdit && (
                            <TableCell>
                              <div className="flex gap-1">
                                {item.bulkAvailable > 0 && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-6 text-xs px-2"
                                    onClick={() => onTransfer(item.locationId, item.locationCode, item.variantId, item.sku)}
                                  >
                                    <ArrowLeftRight className="h-3 w-3 mr-1" />
                                    Replen
                                  </Button>
                                )}
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 text-xs px-2"
                                  onClick={() => onAdjust(item.locationId, item.locationCode, item.variantId, item.sku, item.currentQty)}
                                >
                                  <Edit className="h-3 w-3" />
                                </Button>
                              </div>
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
                    <div key={`${item.locationId}-${item.variantId}`} className="rounded-md border p-3">
                      <div className="flex justify-between">
                        <div>
                          <div className="font-mono text-sm font-medium">{item.sku}</div>
                          <div className="text-xs text-muted-foreground">{item.locationCode}</div>
                        </div>
                        <div className="text-right">
                          <div className={`font-mono font-bold ${item.currentQty === 0 ? "text-red-600" : "text-amber-600"}`}>
                            {item.currentQty}
                          </div>
                          <div className="text-xs text-blue-600">Bulk: {item.bulkAvailable}</div>
                        </div>
                      </div>
                      <div className="flex items-center justify-between mt-2">
                        <div>{item.pendingReplenStatus && replenStatusBadge(item.pendingReplenStatus)}</div>
                        {canEdit && (
                          <div className="flex gap-1">
                            {item.bulkAvailable > 0 && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 text-xs"
                                onClick={() => onTransfer(item.locationId, item.locationCode, item.variantId, item.sku)}
                              >
                                Replen
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 text-xs"
                              onClick={() => onAdjust(item.locationId, item.locationCode, item.variantId, item.sku, item.currentQty)}
                            >
                              Adjust
                            </Button>
                          </div>
                        )}
                      </div>
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
