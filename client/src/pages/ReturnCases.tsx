import { RotateCcw } from "lucide-react";
import { ReturnCaseAdminPanel } from "@/components/returns/ReturnCaseAdminPanel";
import { ReturnOpsTab } from "@/pages/Dropship";

export default function ReturnCases() {
  return (
    <div className="space-y-6 p-2 md:p-6">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-bold md:text-2xl">
          <RotateCcw className="h-5 w-5 md:h-6 md:w-6" />
          Return Cases
        </h1>
        <p className="text-sm text-muted-foreground">
          Manage return cases across retail and dropship channels.
        </p>
      </div>

      <ReturnCaseAdminPanel />

      <section className="space-y-3 border-t pt-6">
        <div>
          <h2 className="text-lg font-semibold">Dropship RMA operations</h2>
          <p className="text-sm text-muted-foreground">
            Create and inspect dropship RMAs while legacy records are adapted to
            canonical return cases.
          </p>
        </div>
        <ReturnOpsTab showLegacyPolicyPanel={false} />
      </section>
    </div>
  );
}
