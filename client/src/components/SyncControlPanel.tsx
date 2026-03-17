import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Zap, Play, RefreshCw } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

interface SyncSettings {
  id: number;
  globalEnabled: boolean;
  sweepIntervalMinutes: number;
  lastSweepAt: string | null;
  lastSweepDurationMs: number | null;
  updatedAt: string;
}

interface SyncStatus {
  global: SyncSettings;
  channels: Array<{
    id: number;
    name: string;
    provider: string;
    syncEnabled: boolean;
    syncMode: string;
    sweepIntervalMinutes: number;
  }>;
  summary: {
    pushed: number;
    dryRun: number;
    errors: number;
    skipped: number;
  };
}

export default function SyncControlPanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: status, isLoading } = useQuery<SyncStatus>({
    queryKey: ["/api/sync/status"],
    queryFn: () => apiRequest("GET", "/api/sync/status").then((r) => r.json()),
    refetchInterval: 30000,
  });

  const toggleGlobalMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await apiRequest("PUT", "/api/sync/settings", {
        globalEnabled: enabled,
      });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/sync/status"] });
      toast({
        title: data.globalEnabled ? "Sync Engine enabled" : "Sync Engine disabled",
      });
    },
  });

  const updateIntervalMutation = useMutation({
    mutationFn: async (minutes: number) => {
      const res = await apiRequest("PUT", "/api/sync/settings", {
        sweepIntervalMinutes: minutes,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sync/status"] });
      toast({ title: "Sweep interval updated" });
    },
  });

  const triggerSyncMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/sync/trigger");
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/sync/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sync/log"] });
      toast({ title: "Sync triggered", description: data.message });
    },
    onError: (err: any) => {
      toast({ title: "Sync failed", description: err.message, variant: "destructive" });
    },
  });

  if (isLoading || !status) {
    return (
      <Card>
        <CardContent className="p-4 flex items-center justify-center">
          <Loader2 className="animate-spin h-5 w-5 text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  const { global: globalSettings, summary } = status;
  const lastSweep = globalSettings.lastSweepAt
    ? formatDistanceToNow(new Date(globalSettings.lastSweepAt), { addSuffix: true })
    : "Never";

  const nextSweepMinutes = globalSettings.sweepIntervalMinutes;
  let nextSweep = `in ${nextSweepMinutes} min`;
  if (globalSettings.lastSweepAt) {
    const elapsed = (Date.now() - new Date(globalSettings.lastSweepAt).getTime()) / 60000;
    const remaining = Math.max(0, nextSweepMinutes - elapsed);
    nextSweep = remaining > 1 ? `in ${Math.round(remaining)} min` : "soon";
  }

  return (
    <Card className="border-2">
      <CardContent className="p-4">
        <div className="flex flex-col md:flex-row md:items-center gap-4">
          {/* Global toggle */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Zap
                size={20}
                className={
                  globalSettings.globalEnabled
                    ? "text-green-500"
                    : "text-muted-foreground"
                }
              />
              <span className="font-semibold text-lg">Sync Engine</span>
            </div>
            <Switch
              checked={globalSettings.globalEnabled}
              onCheckedChange={(checked) => toggleGlobalMutation.mutate(checked)}
              disabled={toggleGlobalMutation.isPending}
            />
            <Badge
              variant={globalSettings.globalEnabled ? "default" : "secondary"}
              className={
                globalSettings.globalEnabled
                  ? "bg-green-600 hover:bg-green-700"
                  : ""
              }
            >
              {globalSettings.globalEnabled ? "ON" : "OFF"}
            </Badge>
          </div>

          {/* Sweep interval */}
          {globalSettings.globalEnabled && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Sweep every</span>
              <Select
                value={String(globalSettings.sweepIntervalMinutes)}
                onValueChange={(v) => updateIntervalMutation.mutate(parseInt(v))}
              >
                <SelectTrigger className="w-24 h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="5">5 min</SelectItem>
                  <SelectItem value="10">10 min</SelectItem>
                  <SelectItem value="15">15 min</SelectItem>
                  <SelectItem value="30">30 min</SelectItem>
                  <SelectItem value="60">60 min</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Status line */}
          {globalSettings.globalEnabled && (
            <div className="text-sm text-muted-foreground flex items-center gap-3">
              <span>Last sweep: {lastSweep}</span>
              <span className="text-muted-foreground/50">|</span>
              <span>Next: {nextSweep}</span>
            </div>
          )}

          {/* Manual trigger */}
          {globalSettings.globalEnabled && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1 ml-auto"
              onClick={() => triggerSyncMutation.mutate()}
              disabled={triggerSyncMutation.isPending}
            >
              {triggerSyncMutation.isPending ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Play size={14} />
              )}
              Run Now
            </Button>
          )}
        </div>

        {/* Summary badges */}
        {globalSettings.globalEnabled && summary && (
          <div className="flex gap-3 mt-3 pt-3 border-t">
            <span className="text-xs text-muted-foreground">Last 24h:</span>
            <Badge variant="outline" className="text-xs text-green-600 border-green-500/30">
              {summary.pushed} pushed
            </Badge>
            <Badge variant="outline" className="text-xs text-yellow-600 border-yellow-500/30">
              {summary.dryRun} dry-run
            </Badge>
            {summary.errors > 0 && (
              <Badge variant="outline" className="text-xs text-red-600 border-red-500/30">
                {summary.errors} errors
              </Badge>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
