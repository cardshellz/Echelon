import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { ReturnCaseAdminPanel } from "@/components/returns/ReturnCaseAdminPanel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ReturnOpsTab } from "@/pages/Dropship";

export default function ReturnCases() {
  const [activeTab, setActiveTab] = useState("rmas");
  const [selectedLegacyRmaId, setSelectedLegacyRmaId] = useState<number | null>(
    null,
  );

  return (
    <div className="space-y-6 p-2 md:p-6">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-bold md:text-2xl">
          <RotateCcw className="h-5 w-5 md:h-6 md:w-6" />
          RMAs
        </h1>
        <p className="text-sm text-muted-foreground">
          Manage RMAs across retail and dropship channels.
        </p>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="space-y-4"
      >
        <TabsList>
          <TabsTrigger value="rmas">RMAs</TabsTrigger>
          <TabsTrigger value="receiving">Receiving &amp; inspection</TabsTrigger>
        </TabsList>
        <TabsContent value="rmas">
          <ReturnCaseAdminPanel
            onOpenLegacyRma={(rmaId) => {
              setSelectedLegacyRmaId(rmaId);
              setActiveTab("receiving");
            }}
          />
        </TabsContent>
        <TabsContent value="receiving">
          <ReturnOpsTab
            showCreatePanel={false}
            showLegacyPolicyPanel={false}
            initialRmaId={selectedLegacyRmaId}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
