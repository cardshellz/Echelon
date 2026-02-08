import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Edit, Clock, PackageX } from "lucide-react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChevronDown, ChevronRight } from "lucide-react";

interface NegativeItem {
  levelId: number;
  variantId: number;
  sku: string;
  name: string;
  variantQty: number;
  locationId: number;
  locationCode: string;
}

interface EmptyPickFace {
  locationId: number;
  locationCode: string;
  lastSku: string | null;
  lastMovementAt: string | null;
}

interface StaleBin {
  locationId: number;
  locationCode: string;
  locationType: string;
  skuCount: number;
  totalQty: number;
  lastMovementAt: string | null;
  daysSinceMovement: number | null;
}

interface Exceptions {
  negativeInventory: NegativeItem[];
  emptyPickFaces: EmptyPickFace[];
  staleBins: StaleBin[];
}

interface ExceptionsSectionProps {
  warehouseId: number | null;
  canEdit: boolean;
  onAdjust: (locationId: number, locationCode: string, variantId: number, sku: string, currentQty: number) => void;
}

export default function ExceptionsSection({ warehouseId, canEdit, onAdjust }: ExceptionsSectionProps) {
  const [isOpen, setIsOpen] = useState(false);

  const { data, isLoading } = useQuery<Exceptions>({
    queryKey: ["/api/operations/exceptions", warehouseId],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (warehouseId) params.set("warehouseId", warehouseId.toString());
      const res = await fetch(`/api/operations/exceptions?${params}`);
      if (!res.ok) throw new Error("Failed to fetch exceptions");
      return res.json();
    },
    staleTime: 60_000,
  });

  const totalExceptions = data
    ? data.negativeInventory.length + data.emptyPickFaces.length + data.staleBins.length
    : 0;

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div className="rounded-lg border bg-card">
        <CollapsibleTrigger className="flex items-center justify-between w-full p-4 hover:bg-muted/30">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-red-600" />
            <h3 className="font-semibold text-base">Exceptions</h3>
            {totalExceptions > 0 && (
              <Badge variant="secondary" className="text-xs bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400">
                {totalExceptions}
              </Badge>
            )}
          </div>
          {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t">
            {isLoading ? (
              <div className="text-sm text-muted-foreground py-6 text-center">Loading...</div>
            ) : totalExceptions === 0 ? (
              <div className="text-sm text-green-600 py-6 text-center">No exceptions found</div>
            ) : (
              <Tabs defaultValue="negative" className="p-3">
                <TabsList className="bg-muted/50">
                  <TabsTrigger value="negative" className="text-xs">
                    Negative ({data!.negativeInventory.length})
                  </TabsTrigger>
                  <TabsTrigger value="empty-pick" className="text-xs">
                    Empty Pick ({data!.emptyPickFaces.length})
                  </TabsTrigger>
                  <TabsTrigger value="stale" className="text-xs">
                    Stale ({data!.staleBins.length})
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="negative" className="mt-3">
                  {data!.negativeInventory.length === 0 ? (
                    <div className="text-sm text-muted-foreground text-center py-4">None</div>
                  ) : (
                    <div className="hidden md:block">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>SKU</TableHead>
                            <TableHead>Name</TableHead>
                            <TableHead>Location</TableHead>
                            <TableHead className="text-right">Qty</TableHead>
                            {canEdit && <TableHead className="w-[80px]"></TableHead>}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {data!.negativeInventory.map((item) => (
                            <TableRow key={item.levelId}>
                              <TableCell className="font-mono text-sm">{item.sku}</TableCell>
                              <TableCell className="text-sm text-muted-foreground truncate max-w-[200px]">{item.name}</TableCell>
                              <TableCell className="font-mono text-sm">{item.locationCode}</TableCell>
                              <TableCell className="text-right font-mono font-medium text-red-600">
                                {item.variantQty}
                              </TableCell>
                              {canEdit && (
                                <TableCell>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-7 text-xs"
                                    onClick={() => onAdjust(item.locationId, item.locationCode, item.variantId, item.sku, item.variantQty)}
                                  >
                                    <Edit className="h-3.5 w-3.5 mr-1" />
                                    Fix
                                  </Button>
                                </TableCell>
                              )}
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                  {/* Mobile for negative */}
                  <div className="md:hidden space-y-2">
                    {data!.negativeInventory.map((item) => (
                      <div key={item.levelId} className="rounded-md border p-3 border-red-200">
                        <div className="flex justify-between">
                          <span className="font-mono text-sm">{item.sku}</span>
                          <span className="font-mono font-bold text-red-600">{item.variantQty}</span>
                        </div>
                        <div className="text-xs text-muted-foreground">{item.locationCode}</div>
                      </div>
                    ))}
                  </div>
                </TabsContent>

                <TabsContent value="empty-pick" className="mt-3">
                  {data!.emptyPickFaces.length === 0 ? (
                    <div className="text-sm text-muted-foreground text-center py-4">None</div>
                  ) : (
                    <div className="hidden md:block">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Location</TableHead>
                            <TableHead>Last SKU</TableHead>
                            <TableHead>Last Movement</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {data!.emptyPickFaces.map((item) => (
                            <TableRow key={item.locationId}>
                              <TableCell className="font-mono text-sm">{item.locationCode}</TableCell>
                              <TableCell className="font-mono text-sm text-muted-foreground">{item.lastSku || "—"}</TableCell>
                              <TableCell className="text-sm text-muted-foreground">
                                {item.lastMovementAt ? new Date(item.lastMovementAt).toLocaleDateString() : "Never"}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                  <div className="md:hidden space-y-2">
                    {data!.emptyPickFaces.map((item) => (
                      <div key={item.locationId} className="rounded-md border p-3">
                        <div className="font-mono text-sm">{item.locationCode}</div>
                        <div className="text-xs text-muted-foreground">
                          Last: {item.lastSku || "unknown"} — {item.lastMovementAt ? new Date(item.lastMovementAt).toLocaleDateString() : "never"}
                        </div>
                      </div>
                    ))}
                  </div>
                </TabsContent>

                <TabsContent value="stale" className="mt-3">
                  {data!.staleBins.length === 0 ? (
                    <div className="text-sm text-muted-foreground text-center py-4">None</div>
                  ) : (
                    <div className="hidden md:block">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Location</TableHead>
                            <TableHead>Type</TableHead>
                            <TableHead className="text-right">SKUs</TableHead>
                            <TableHead className="text-right">Qty</TableHead>
                            <TableHead className="text-right">Days Stale</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {data!.staleBins.map((item) => (
                            <TableRow key={item.locationId}>
                              <TableCell className="font-mono text-sm">{item.locationCode}</TableCell>
                              <TableCell>
                                <Badge variant="outline" className="text-[10px]">
                                  {item.locationType.replace("_", " ")}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-right font-mono">{item.skuCount}</TableCell>
                              <TableCell className="text-right font-mono">{item.totalQty.toLocaleString()}</TableCell>
                              <TableCell className="text-right">
                                <span className="text-amber-600 font-mono">
                                  {item.daysSinceMovement ?? "∞"}d
                                </span>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                  <div className="md:hidden space-y-2">
                    {data!.staleBins.map((item) => (
                      <div key={item.locationId} className="rounded-md border p-3">
                        <div className="flex justify-between">
                          <span className="font-mono text-sm">{item.locationCode}</span>
                          <span className="text-amber-600 text-sm">{item.daysSinceMovement ?? "∞"}d stale</span>
                        </div>
                        <div className="text-xs text-muted-foreground">{item.skuCount} SKUs, {item.totalQty} units</div>
                      </div>
                    ))}
                  </div>
                </TabsContent>
              </Tabs>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
