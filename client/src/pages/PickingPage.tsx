import { useLocation } from "wouter";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/lib/auth";
import PickingQueue from "./Picking";
import PickingLogs from "./PickingLogs";
import PickingMetrics from "./PickingMetrics";

export default function PickingPage() {
  const [location, navigate] = useLocation();
  const { user } = useAuth();
  const isAdminLead = user?.role === "admin" || user?.role === "lead";

  let activeTab = "queue";
  if (isAdminLead && location.startsWith("/picking/logs")) activeTab = "logs";
  else if (isAdminLead && location.startsWith("/picking/metrics")) activeTab = "metrics";

  const handleTabChange = (tab: string) => {
    if (tab === "queue") navigate("/picking");
    else navigate(`/picking/${tab}`);
  };

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange} className="flex flex-col h-full">
      <div className="border-b px-4 pt-1 bg-card shrink-0">
        <TabsList className="bg-transparent">
          <TabsTrigger value="queue">Queue</TabsTrigger>
          {isAdminLead && <TabsTrigger value="logs">Logs</TabsTrigger>}
          {isAdminLead && <TabsTrigger value="metrics">Metrics</TabsTrigger>}
        </TabsList>
      </div>
      <TabsContent value="queue" className="mt-0 flex-1">
        <PickingQueue />
      </TabsContent>
      {isAdminLead && (
        <TabsContent value="logs" className="mt-0 flex-1 overflow-auto">
          <PickingLogs />
        </TabsContent>
      )}
      {isAdminLead && (
        <TabsContent value="metrics" className="mt-0 flex-1 overflow-auto">
          <PickingMetrics />
        </TabsContent>
      )}
    </Tabs>
  );
}
