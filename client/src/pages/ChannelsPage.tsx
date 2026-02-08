import { useLocation } from "wouter";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import Channels from "./Channels";
import Reserves from "./Reserves";

export default function ChannelsPage() {
  const [location, navigate] = useLocation();

  const activeTab = location.startsWith("/channels/reserves") ? "reserves" : "channels";

  const handleTabChange = (tab: string) => {
    if (tab === "channels") navigate("/channels");
    else navigate("/channels/reserves");
  };

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange} className="flex flex-col h-full">
      <div className="border-b px-4 pt-1 bg-card shrink-0">
        <TabsList className="bg-transparent">
          <TabsTrigger value="channels">Channels</TabsTrigger>
          <TabsTrigger value="reserves">Reserves</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="channels" className="mt-0 flex-1 overflow-auto">
        <Channels />
      </TabsContent>
      <TabsContent value="reserves" className="mt-0 flex-1 overflow-auto">
        <Reserves />
      </TabsContent>
    </Tabs>
  );
}
