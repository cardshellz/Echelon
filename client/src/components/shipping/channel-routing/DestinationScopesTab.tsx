import { useQuery } from "@tanstack/react-query";
import { CircleAlert, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  CHANNEL_ROUTING_KEY,
  loadChannelRouting,
} from "./api";
import { DeliveryRegionsPanel } from "./DeliveryRegionsPanel";

export function DestinationScopesTab() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: [CHANNEL_ROUTING_KEY],
    queryFn: loadChannelRouting,
  });

  if (isLoading) {
    return (
      <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading destinations
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center gap-3 border">
        <CircleAlert className="h-5 w-5 text-destructive" />
        <p className="text-sm font-medium">Destinations could not be loaded.</p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Retry
        </Button>
      </div>
    );
  }

  return <DeliveryRegionsPanel scopes={data.destinationScopes} />;
}
