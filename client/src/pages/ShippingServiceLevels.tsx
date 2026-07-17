import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
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
  fulfillmentModeLabel,
  loadShippingServiceLevels,
  serviceLevelPromise,
  SHIPPING_ADMIN_CONFIG_KEY,
} from "@/components/shipping/service-levels/api";
import { ArrowRight, Loader2, Route, Truck } from "lucide-react";

export default function ShippingServiceLevels() {
  const [, navigate] = useLocation();
  const { data, isLoading, isError } = useQuery({
    queryKey: [SHIPPING_ADMIN_CONFIG_KEY],
    queryFn: loadShippingServiceLevels,
  });

  const levels = [...(data?.serviceLevels ?? [])].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.id - b.id,
  );
  const currentOptionCount = levels.some((level) => level.code === "standard") ? 1 : 0;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-6">
      <header className="flex items-start gap-3">
        <Route className="mt-0.5 h-6 w-6" />
        <div>
          <h1 className="text-xl font-semibold md:text-2xl">Service Levels</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Customer-facing delivery options. Standard Shipping is the initial checkout option.
          </p>
        </div>
      </header>

      <section aria-labelledby="service-level-list-heading">
        <div className="mb-3 flex items-end justify-between gap-4">
          <div>
            <h2 id="service-level-list-heading" className="text-base font-semibold">
              Shipping options
            </h2>
            <p className="text-sm text-muted-foreground">
              Manage Standard now. Additional speeds and pallet freight remain reserved for later.
            </p>
          </div>
          <Badge variant="outline">{currentOptionCount} current option</Badge>
        </div>

        <div className="overflow-hidden rounded-md border bg-background">
          {isLoading ? (
            <div className="flex min-h-52 items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : isError ? (
            <div className="min-h-52 p-8 text-center text-sm text-destructive">
              Service levels could not be loaded.
            </div>
          ) : levels.length === 0 ? (
            <div className="flex min-h-52 flex-col items-center justify-center gap-2 p-8 text-center">
              <Truck className="h-9 w-9 text-muted-foreground" />
              <p className="font-medium">No service levels configured</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Shipping option</TableHead>
                  <TableHead>Delivery type</TableHead>
                  <TableHead>Checkout promise</TableHead>
                  <TableHead>Availability</TableHead>
                  <TableHead className="w-28 text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {levels.map((level) => {
                  const isCurrent = level.code === "standard";
                  return (
                    <TableRow
                      key={level.id}
                      className={isCurrent ? "cursor-pointer" : "bg-muted/20"}
                      onClick={() => {
                        if (isCurrent) navigate(`/shipping-service-levels/${level.id}`);
                      }}
                      data-testid={`service-level-row-${level.code}`}
                    >
                      <TableCell>
                        <div className="font-medium">{level.displayName}</div>
                        <div className="max-w-md text-sm text-muted-foreground">
                          {level.description || "No customer-facing description"}
                        </div>
                      </TableCell>
                      <TableCell>{fulfillmentModeLabel(level.fulfillmentMode)}</TableCell>
                      <TableCell>{serviceLevelPromise(level)}</TableCell>
                      <TableCell>
                        <Badge variant={isCurrent && level.isActive ? "default" : "secondary"}>
                          {isCurrent ? (level.isActive ? "Active" : "Inactive") : "Future"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {isCurrent ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            title={`Manage ${level.displayName}`}
                            aria-label={`Manage ${level.displayName}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              navigate(`/shipping-service-levels/${level.id}`);
                            }}
                          >
                            <ArrowRight className="h-4 w-4" />
                          </Button>
                        ) : (
                          <span className="text-sm text-muted-foreground">Planned</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
      </section>
    </div>
  );
}
