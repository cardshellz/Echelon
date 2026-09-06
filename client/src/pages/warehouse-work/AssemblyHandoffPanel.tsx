import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { useAuth } from "@/lib/auth";
import { assemblyOrderInstructionsSchema, type AssemblyOrderInstructions } from "@shared/warehouse-assembly-execution";
import { canonicalAvailabilityClaimBuildHandoffResultSchema } from "@shared/types/inventory-availability-claims";
import { Button } from "@/components/ui/button";
import { assemblyRequest } from "./assembly-api";
import { useAssemblyCommand } from "./use-assembly-command";

type Instruction = AssemblyOrderInstructions["instructions"][number];
export function AssemblyHandoffCard({ instruction, onHandedOff }: {
  instruction: Instruction; onHandedOff: (ticket: string, station: string) => void | Promise<void>;
}) {
  const [stationId, setStationId] = useState(instruction.routes.length === 1 ? instruction.routes[0].station.id : "");
  const route = instruction.routes.find((entry) => entry.station.id === stationId);
  const command = useAssemblyCommand(canonicalAvailabilityClaimBuildHandoffResultSchema, (result) => onHandedOff(result.buildSystemNumber, route?.station.name ?? "the assembly station"));
  return <section className="rounded-md border border-amber-400 bg-amber-50 p-3 text-slate-900 space-y-2" aria-label={`Assembly for ${instruction.sku}`}>
    <h3 className="font-semibold">Assembly required: {instruction.committedOutputQty} × {instruction.sku}</h3>
    <p className="text-sm">{instruction.name}. Build output: {instruction.outputQty}. Materials stay at the configured assembly area.</p>
    <ul className="text-sm list-disc pl-5">{instruction.inputs.map((input) => <li key={input.variantId}>{input.quantity} × {input.sku} — {input.name}</li>)}</ul>
    {instruction.task ? <p className="text-sm font-medium">Sent to {instruction.task.station.name} · {instruction.task.buildSystemNumber} · {instruction.task.state}. Hand over this order’s shipping label and instructions. This is not a completed pick.</p> : <>
      {instruction.blocker ? <p role="status" className="text-sm">{instruction.blocker}</p> : <>
        <label className="block text-sm">Assembly destination
          <select className="mt-1 h-11 w-full rounded border bg-white px-2" value={stationId} disabled={command.isPending || command.uncertain} onChange={(event) => setStationId(event.target.value)}>
            <option value="">Choose a permitted station</option>
            {instruction.routes.map((entry) => <option key={entry.station.id} value={entry.station.id}>{entry.station.code} — {entry.station.name}</option>)}
          </select>
        </label>
        <p className="text-sm">Print the shipping label in ShipStation as usual. Send the job here, then pass its label and instructions to this station. No stock moves on handoff.</p>
        <Button className="h-12 w-full" disabled={!route || command.isPending || command.uncertain} onClick={() => route && command.mutate({
          url: "/api/warehouse/assembly-work/handoffs", body: { claimId: instruction.claimId, operationKey: instruction.operationKey,
            reason: "Picker routed assembly work; physical label receipt remains with the assembler", route: { warehouseId: route.warehouseId,
              stationId: route.station.id, configurationRevision: route.configurationRevision, acknowledgeWorkOnlyHandoff: true } },
        })}>{command.isPending ? "Recording handoff…" : "Send to assembly"}</Button>
      </>}
    </>}
    {command.error && <p role="alert" className="text-sm">{command.error.message}</p>}
    {command.uncertain && <Button variant="outline" onClick={command.retryOriginal} disabled={command.isPending}>Retry the same handoff request</Button>}
  </section>;
}
export default function AssemblyHandoffPanel({ orderId, onHandedOff }: { orderId: number; onHandedOff: (ticket: string, station: string) => void | Promise<void> }) {
  const { user } = useAuth();
  const query = useQuery({ queryKey: ["assembly", "order", user?.id, orderId], queryFn: () => assemblyRequest(`/api/warehouse/assembly-work/orders/${orderId}`, assemblyOrderInstructionsSchema), retry: false, staleTime: 0 });
  if (query.isPending) return <p className="p-3 text-sm">Checking committed assembly work…</p>;
  if (query.error) return <div className="p-3 text-sm" role="status">Assembly check unavailable: {query.error.message} <Button variant="outline" onClick={() => query.refetch()}>Retry check</Button></div>;
  if (!query.data.instructions.length) return null;
  return <div className="p-3 space-y-3 max-w-3xl mx-auto w-full">
    {query.data.instructions.map((instruction) => <AssemblyHandoffCard key={`${user?.id}:${instruction.claimId}:${instruction.operationKey}`} instruction={instruction} onHandedOff={onHandedOff} />)}
    <Link href="/assembly" className="text-sm underline">Open assembly work</Link>
  </div>;
}
