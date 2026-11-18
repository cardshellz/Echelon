import { useLocation } from "wouter";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/lib/auth";
import PickingQueue from "./Picking";
import PickingLogs from "./PickingLogs";
import PickingMetrics from "./PickingMetrics";
import PickingSettings from "./PickingSettings";

export default function PickingPage() {
  const [location, navigate] = useLocation();
  const { hasPermission } = useAuth();
  const canViewLogs = hasPermission("picking", "view_logs");
  const canViewMetrics = hasPermission("picking", "view_metrics");
  const canManageSettings = hasPermission("picking", "manage_settings");

  let activeTab = "queue";
  if (canViewLogs && location.startsWith("/picking/logs")) activeTab = "logs";
  else if (canViewMetrics && location.startsWith("/picking/metrics")) activeTab = "metrics";
  else if (canManageSettings && location.startsWith("/picking/settings")) activeTab = "settings";

  const handleTabChange = (tab: string) => {
    if (tab === "queue") navigate("/picking");
    else navigate(`/picking/${tab}`);
  };

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange} className="flex flex-col h-full">
      <div className="border-b px-4 pt-1 bg-card shrink-0">
        <TabsList className="bg-transparent">
          <TabsTrigger value="queue">Queue</TabsTrigger>
          {canViewLogs && <TabsTrigger value="logs">Logs</TabsTrigger>}
          {canViewMetrics && <TabsTrigger value="metrics">Metrics</TabsTrigger>}
          {canManageSettings && <TabsTrigger value="settings">Settings</TabsTrigger>}
        </TabsList>
      </div>
      <TabsContent value="queue" className="mt-0 flex-1">
        <PickingQueue />
      </TabsContent>
      {canViewLogs && (
        <TabsContent value="logs" className="mt-0 flex-1 overflow-auto">
          <PickingLogs />
        </TabsContent>
      )}
      {canViewMetrics && (
        <TabsContent value="metrics" className="mt-0 flex-1 overflow-auto">
          <PickingMetrics />
        </TabsContent>
      )}
      {canManageSettings && (
        <TabsContent value="settings" className="mt-0 flex-1 overflow-auto">
          <PickingSettings />
        </TabsContent>
      )}
    </Tabs>
  );
}
