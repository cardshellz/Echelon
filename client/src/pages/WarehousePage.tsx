import { useLocation } from "wouter";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import Warehouses from "./Warehouses";
import WarehouseLocations from "./WarehouseLocations";

export default function WarehousePage() {
  const [location, navigate] = useLocation();

  const activeTab = location.startsWith("/warehouse/locations") ? "locations" : "warehouses";

  const handleTabChange = (tab: string) => {
    if (tab === "warehouses") navigate("/warehouse");
    else navigate("/warehouse/locations");
  };

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange} className="flex flex-col h-full">
      <div className="border-b px-4 pt-1 bg-card shrink-0">
        <TabsList className="bg-transparent">
          <TabsTrigger value="warehouses">Warehouses</TabsTrigger>
          <TabsTrigger value="locations">Locations</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="warehouses" className="mt-0 flex-1 overflow-auto">
        <Warehouses />
      </TabsContent>
      <TabsContent value="locations" className="mt-0 flex-1 overflow-auto">
        <WarehouseLocations />
      </TabsContent>
    </Tabs>
  );
}
