import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Loader2 } from "lucide-react";

interface ChannelSyncConfig {
  syncEnabled: boolean;
  syncMode: string;
  sweepIntervalMinutes: number;
}

export default function ChannelSyncControls({
  channelId,
  channelName,
}: {
  channelId: number;
  channelName: string;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: config, isLoading } = useQuery<ChannelSyncConfig>({
    queryKey: [`/api/sync/channels/${channelId}`],
    queryFn: () =>
      apiRequest("GET", `/api/sync/channels/${channelId}`).then((r) => r.json()),
  });

  const updateMutation = useMutation({
    mutationFn: async (updates: Partial<ChannelSyncConfig>) => {
      const res = await apiRequest("PUT", `/api/sync/channels/${channelId}`, updates);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/sync/channels/${channelId}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/sync/status"] });
    },
  });

  if (isLoading || !config) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="animate-spin h-3 w-3" />
        Loading sync...
      </div>
    );
  }

  const toggleEnabled = () => {
    updateMutation.mutate({ syncEnabled: !config.syncEnabled });
  };

  const toggleMode = () => {
    const newMode = config.syncMode === "live" ? "dry_run" : "live";
    updateMutation.mutate({ syncMode: newMode });
    toast({
      title: `${channelName}: ${newMode === "live" ? "Live sync" : "Dry-run mode"}`,
    });
  };

  return (
    <div className="flex items-center gap-3 border-t pt-2 mt-1">
      <div className="flex items-center gap-1.5">
        <Switch
          checked={config.syncEnabled}
          onCheckedChange={toggleEnabled}
          disabled={updateMutation.isPending}
          className="scale-75 origin-left"
        />
        <span className="text-xs font-medium">
          {config.syncEnabled ? "Sync On" : "Sync Off"}
        </span>
      </div>

      {config.syncEnabled && (
        <button
          onClick={toggleMode}
          disabled={updateMutation.isPending}
          className="cursor-pointer"
        >
          <Badge
            variant={config.syncMode === "live" ? "default" : "secondary"}
            className={
              config.syncMode === "live"
                ? "bg-green-600 hover:bg-green-700 text-[10px] cursor-pointer"
                : "bg-yellow-500/20 text-yellow-600 border-yellow-500/30 text-[10px] cursor-pointer"
            }
          >
            {config.syncMode === "live" ? "LIVE" : "DRY RUN"}
          </Badge>
        </button>
      )}
    </div>
  );
}
