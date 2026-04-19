import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Map } from "lucide-react";

interface PickZone {
  id: number;
  warehouseId: number;
  warehouseCode: string | null;
  warehouseName: string | null;
  code: string;
  name: string;
  priority: number;
  strategy: "zone_sequence" | "shortest_path" | "fifo";
  uomHierarchyMin: number | null;
  uomHierarchyMax: number | null;
  equipmentType: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

const strategyLabel: Record<PickZone["strategy"], string> = {
  zone_sequence: "Zone Sequence",
  shortest_path: "Shortest Path",
  fifo: "FIFO",
};

const strategyDescription: Record<PickZone["strategy"], string> = {
  zone_sequence: "Walk zones in fixed order. Predictable.",
  shortest_path: "Algorithmic shortest route (stub — currently same as zone sequence).",
  fifo: "Pick in the order items were added. Simple.",
};

export default function PickZones() {
  const { data: zones, isLoading } = useQuery<PickZone[]>({
    queryKey: ["/api/warehouse-pick-zones"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/warehouse-pick-zones");
      return res.json();
    },
  });

  const zonesByWarehouse = new Map<number, PickZone[]>();
  for (const z of zones ?? []) {
    if (!zonesByWarehouse.has(z.warehouseId)) zonesByWarehouse.set(z.warehouseId, []);
    zonesByWarehouse.get(z.warehouseId)!.push(z);
  }

  return (
    <div className="container mx-auto p-4 md:p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-semibold flex items-center gap-2">
            <Map className="w-7 h-7" />
            Pick Zones
          </h1>
          <p className="text-muted-foreground text-sm md:text-base mt-1">
            Logical groups of locations that share a pick strategy and priority.
            Each warehouse has one DEFAULT zone; additional zones (EACH, CASE,
            PALLET) can be added later to split pick paths by UOM tier or
            equipment type.
          </p>
        </div>
      </div>

      <Card className="border-amber-500/40 bg-amber-50/40 dark:bg-amber-950/20">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-amber-500" />
            Read-only preview
          </CardTitle>
          <CardDescription className="text-sm">
            This page displays the pick zones currently in the database. Zones
            are infrastructure-only today — creating, editing and assigning
            locations to zones will be unlocked in a follow-up release. The
            picker service does not yet branch on zone.
          </CardDescription>
        </CardHeader>
      </Card>

      {isLoading && (
        <p className="text-muted-foreground">Loading pick zones…</p>
      )}

      {!isLoading && (zones?.length ?? 0) === 0 && (
        <Card>
          <CardContent className="py-8">
            <p className="text-muted-foreground text-sm">
              No pick zones found. Every warehouse should have at least a
              DEFAULT zone seeded by the latest migration — if you see this,
              re-run migration <code>0081_pick_zones_infrastructure.sql</code>.
            </p>
          </CardContent>
        </Card>
      )}

      {Array.from(zonesByWarehouse.entries()).map(([warehouseId, zonesForWarehouse]) => {
        const wh = zonesForWarehouse[0];
        return (
          <Card key={warehouseId}>
            <CardHeader>
              <CardTitle className="text-lg">
                {wh.warehouseName ?? `Warehouse #${warehouseId}`}
                {wh.warehouseCode && (
                  <span className="text-muted-foreground font-normal ml-2 text-sm">
                    ({wh.warehouseCode})
                  </span>
                )}
              </CardTitle>
              <CardDescription>
                {zonesForWarehouse.length} zone{zonesForWarehouse.length === 1 ? "" : "s"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-24">Priority</TableHead>
                    <TableHead>Code</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Strategy</TableHead>
                    <TableHead>UOM Range</TableHead>
                    <TableHead>Equipment</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {zonesForWarehouse.map((z) => (
                    <TableRow key={z.id}>
                      <TableCell className="font-mono">{z.priority}</TableCell>
                      <TableCell className="font-mono font-semibold">{z.code}</TableCell>
                      <TableCell>{z.name}</TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="text-sm">{strategyLabel[z.strategy]}</span>
                          <span className="text-xs text-muted-foreground">
                            {strategyDescription[z.strategy]}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">
                        {z.uomHierarchyMin === null && z.uomHierarchyMax === null
                          ? <span className="text-muted-foreground">Any</span>
                          : `${z.uomHierarchyMin ?? "—"}..${z.uomHierarchyMax ?? "—"}`}
                      </TableCell>
                      <TableCell className="text-sm">
                        {z.equipmentType ?? <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell>
                        {z.isActive ? (
                          <Badge variant="outline" className="border-green-500/50 text-green-700 dark:text-green-400">
                            Active
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="border-muted-foreground/50 text-muted-foreground">
                            Inactive
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
