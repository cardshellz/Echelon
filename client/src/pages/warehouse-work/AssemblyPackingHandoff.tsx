import React from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import type { AssemblyTaskView } from "@shared/warehouse-assembly-execution";
import { assemblyPackingResultSchema } from "@shared/warehouse-assembly-packing";
import { useAssemblyCommand } from "./use-assembly-command";

export function AssemblyPackingHandoff({ view, actorId }: { view: AssemblyTaskView; actorId: string }) {
  const [, navigate] = useLocation();
  const client = useQueryClient();
  const command = useAssemblyCommand(assemblyPackingResultSchema, async ({ receipt }) => {
    await client.invalidateQueries({ queryKey: ["/api/shipping/packing/queue"] });
    navigate(receipt.packingUrl);
  });
  if (view.task.assignedTo !== actorId) return <p>The assigned assembler must hand this order to packing.</p>;
  if (view.task.profile.assemblyPacking !== "combined" || !view.task.station.capabilities.includes("packing"))
    return <p>Separate-station packing custody is not connected here. This job remains visible for review.</p>;
  return <div className="space-y-2">
    <p>Continue at this bench with the existing label. The server checks all eligible order lines and unresolved blockers before opening Packing. This does not close a parcel, buy a label, or record dispatch.</p>
    <Button disabled={command.isPending || command.uncertain || view.onHold} onClick={() => command.mutate({
      url: `/api/warehouse/assembly-work/${view.task.id}/packing-ready`, body: {
        expectedVersion: view.task.version, confirmReadyForPacking: true,
        reason: "Assigned assembler continued the fully picked order to combined-station packing",
      },
    })}>Continue to packing</Button>
    {command.error && <p role="alert">{command.error.message}</p>}
    {command.uncertain && <Button disabled={command.isPending} variant="outline" onClick={command.retryOriginal}>Retry the same packing handoff</Button>}
  </div>;
}
