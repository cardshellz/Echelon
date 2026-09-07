import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { assemblyExecutionContextsSchema, assemblyTaskViewSchema, type AssemblyTaskView } from "@shared/warehouse-assembly-execution";
import { assemblyQueueSchema, assemblyTaskResultSchema } from "@shared/warehouse-assembly-work";
import { canonicalAvailabilityClaimOperationExecutionResultSchema, canonicalAvailabilityClaimPickResultSchema } from "@shared/types/inventory-availability-claims";
import { assemblyRequest } from "./assembly-api";
import { useAssemblyCommand } from "./use-assembly-command";
import { AssemblyPackingHandoff } from "./AssemblyPackingHandoff";
import { AssemblyPackageReview } from "./AssemblyPackageReview";

function CommandError({ error, uncertain, retry, pending }: { error: Error | null; uncertain: boolean; retry: () => void; pending: boolean }) {
  return <>{error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}
    {uncertain && <Button variant="outline" onClick={retry} disabled={pending}>Retry the same request — do not redo the physical work</Button>}</>;
}

export function AssemblyJob({ view, actorId }: { view: AssemblyTaskView; actorId: string }) {
  const { task } = view;
  const [received, setReceived] = useState(false);
  const [assembled, setAssembled] = useState(false);
  const [picked, setPicked] = useState(false);
  const [reason, setReason] = useState("");
  const [actualOutput, setActualOutput] = useState("");
  const work = useAssemblyCommand(assemblyTaskResultSchema);
  const build = useAssemblyCommand(canonicalAvailabilityClaimOperationExecutionResultSchema);
  const output = useAssemblyCommand(canonicalAvailabilityClaimPickResultSchema);
  const pending = work.isPending || build.isPending || output.isPending;
  const uncertain = work.uncertain || build.uncertain || output.uncertain;
  const owned = task.assignedTo === actorId;
  const paused = view.onHold || ["shipped", "cancelled"].includes(view.orderStatus);
  const commandUrl = `/api/warehouse/assembly-work/${task.id}/commands`;
  return <article className="rounded-lg border bg-card p-4 space-y-4" aria-label={`Assembly job ${task.buildSystemNumber}`}>
    <header><h2 className="text-xl font-semibold">{view.orderNumber} · {view.sku}</h2>
      <p>{view.name}</p><p className="text-sm text-muted-foreground">{task.buildSystemNumber} · {task.station.code} · {task.state} · revision {task.version}</p>
      {task.assignedTo && <p className="text-sm">Responsible employee: {owned ? "you" : task.assignedTo}</p>}
    </header>
    <div className="rounded bg-muted p-3 space-y-2">
      <p className="font-medium">Make {task.outputQty} × {view.sku}</p>
      <ul className="list-disc pl-5 text-sm">{view.inputs.map((input) => <li key={input.variantId}>{input.quantity} × {input.sku} — {input.name}</li>)}</ul>
      <p className="text-sm">Output location: {view.outputLocationCode ?? "Unavailable — review configuration"}. Do not fetch substitute ingredients or create a different recipe from this screen.</p>
      <p className="text-sm">Use the label already printed for order {view.orderNumber}. Receiving this job records your acknowledgment, not a barcode/provider-label validation or carrier dispatch.</p>
    </div>
    {paused && <p role="alert">This order is held or closed. Do not start/resume work; record a blocker if work is already underway.</p>}
    {task.state === "queued" && <div className="space-y-3">
      <label className="flex gap-2 items-start"><input type="checkbox" checked={received} disabled={pending || uncertain} onChange={(event) => setReceived(event.target.checked)} />I have matched this order’s label and work instructions at {task.station.name}.</label>
      <Button className="h-12" disabled={!received || pending || uncertain || paused} onClick={() => work.mutate({ url: commandUrl,
        body: { action: "start", expectedVersion: task.version, receivedBuildSystemNumber: task.buildSystemNumber,
          confirmPhysicalHandoff: true, reason: "Assembler received the matching order label and work instructions" } })}>Receive & start assembly</Button>
    </div>}
    {owned && task.state === "in_progress" && <div className="space-y-3">
      <label className="block">Actual finished quantity
        <input className="mt-1 h-12 rounded border bg-background px-3 w-full" inputMode="numeric" value={actualOutput} disabled={pending || uncertain} onChange={(event) => setActualOutput(event.target.value)} />
      </label>
      <label className="flex gap-2 items-start"><input type="checkbox" checked={assembled} disabled={pending || uncertain} onChange={(event) => setAssembled(event.target.checked)} />These finished units physically exist. I have used the listed components.</label>
      {actualOutput && actualOutput !== task.outputQty && <p role="status" className="text-sm">This command posts the complete build. If output is incomplete, block the job below; do not report a partial build as complete.</p>}
      <Button className="h-12" disabled={!assembled || actualOutput !== task.outputQty || pending || uncertain || paused} onClick={() => build.mutate({ url: `/api/warehouse/assembly-work/${task.id}/complete`,
        body: { reason: "Assembler confirmed the complete physical build", fence: { taskId: task.id, expectedVersion: task.version,
          completedOutputQty: actualOutput, confirmPhysicalAssembly: true } } })}>Record finished assembly</Button>
    </div>}
    {owned && ["in_progress", "blocked"].includes(task.state) && <div className="space-y-2 border-t pt-3">
      {task.blockedReason && <p role="status">Blocked: {task.blockedReason}</p>}
      <label className="block text-sm">{task.state === "blocked" ? "What was resolved?" : "Missing parts or another problem?"}
        <textarea className="mt-1 w-full rounded border bg-background p-2" maxLength={1000} value={reason} disabled={pending || uncertain} onChange={(event) => setReason(event.target.value)} />
      </label>
      <Button variant="outline" disabled={!reason.trim() || pending || uncertain || (task.state === "blocked" && paused)} onClick={() => work.mutate({ url: commandUrl,
        body: { action: task.state === "blocked" ? "resume" : "block", expectedVersion: task.version, reason } })}>{task.state === "blocked" ? "Resume my work" : "Block job — keep materials reserved"}</Button>
    </div>}
    {task.state === "completed" && <div className="space-y-3 border-t pt-3">
      <h3 className="font-semibold">Assembly recorded. Finished-goods pick is separate.</h3>
      {view.pickedQuantity === view.itemQuantity && view.itemStatus === "completed" ? <>
        <p>All {view.itemQuantity} units are recorded picked for this order. Packing and active-label verification are not recorded by this screen; dispatch remains separate.</p>
        <AssemblyPackingHandoff view={view} actorId={actorId} />
        {owned && <AssemblyPackageReview taskId={task.id} actorId={actorId} />}
      </> : <>
        <p>Place {view.itemQuantity} × {view.sku} from {view.outputLocationCode ?? "the output location"} with order {view.orderNumber}. Leave any surplus at its recorded output location.</p>
        {view.outputPickBlocker ? <p role="status">{view.outputPickBlocker}</p> : <>
          <label className="flex gap-2 items-start"><input type="checkbox" checked={picked} disabled={pending || uncertain} onChange={(event) => setPicked(event.target.checked)} />I physically picked all {view.itemQuantity} finished units for this order.</label>
          <Button className="h-12" disabled={!picked || pending || uncertain || !["pending", "in_progress"].includes(view.itemStatus)} onClick={() => output.mutate({ url: `/api/warehouse/assembly-work/${task.id}/pick-output`,
            body: { quantity: view.itemQuantity, expectedItemStatus: view.itemStatus, reason: "Assembler picked the completed build output into its order",
              fence: { taskId: task.id, expectedVersion: task.version, confirmPhysicalOutput: true } } })}>Record finished-goods pick</Button>
        </>}
      </>}
    </div>}
    <CommandError error={work.error} uncertain={work.uncertain} retry={work.retryOriginal} pending={pending} />
    <CommandError error={build.error} uncertain={build.uncertain} retry={build.retryOriginal} pending={pending} />
    <CommandError error={output.error} uncertain={output.uncertain} retry={output.retryOriginal} pending={pending} />
  </article>;
}

function JobDetail({ id, actorId }: { id: string; actorId: string }) {
  const query = useQuery({ queryKey: ["assembly", "task-view", id, actorId], queryFn: () => assemblyRequest(`/api/warehouse/assembly-work/${id}/view`, assemblyTaskViewSchema), retry: false, refetchInterval: 15000 });
  if (query.isPending) return <p>Loading work instructions…</p>;
  if (query.error) return <p role="alert">{query.error.message} <Button onClick={() => query.refetch()}>Retry</Button></p>;
  return <AssemblyJob key={id} view={query.data} actorId={actorId} />;
}

export default function AssemblyWorkPage() {
  const { user } = useAuth();
  const [warehouseChoice, setWarehouseChoice] = useState("");
  const [stationChoice, setStationChoice] = useState("");
  const [beforeId, setBeforeId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const contexts = useQuery({ queryKey: ["assembly", "contexts", user?.id], queryFn: () => assemblyRequest("/api/warehouse/assembly-work/contexts", assemblyExecutionContextsSchema), retry: false });
  const warehouseId = warehouseChoice || (contexts.data?.contexts.length === 1 ? String(contexts.data.contexts[0].warehouseId) : "");
  const context = contexts.data?.contexts.find((entry) => String(entry.warehouseId) === warehouseId);
  const stationId = stationChoice || (context?.stations.length === 1 ? context.stations[0].id : "");
  const query = useQuery({ queryKey: ["assembly", "queue", user?.id, warehouseId, stationId, beforeId], enabled: !!context,
    queryFn: () => {
      const search = new URLSearchParams({ warehouseId, includeClosed: "true", limit: "50" });
      if (stationId) search.set("stationId", stationId); if (beforeId) search.set("beforeId", beforeId);
      return assemblyRequest(`/api/warehouse/assembly-work?${search}`, assemblyQueueSchema);
    }, retry: false, refetchInterval: 15000 });
  const selectClass = "h-11 w-full rounded border bg-background px-2";
  return <main className="p-4 max-w-6xl mx-auto space-y-4">
    <header><h1 className="text-2xl font-semibold">Assembly work</h1><p className="text-sm text-muted-foreground">Receive work, build, then record the finished-goods pick. No label purchase, packing close, or dispatch is performed here.</p></header>
    <div className="grid gap-3 sm:grid-cols-2">
      <label>Warehouse<select className={selectClass} value={warehouseId} onChange={(event) => { setWarehouseChoice(event.target.value); setStationChoice(""); setBeforeId(null); setSelectedId(null); }}>
        <option value="">Choose a permitted warehouse</option>{contexts.data?.contexts.map((entry) => <option key={entry.warehouseId} value={entry.warehouseId}>{entry.warehouseCode} — {entry.warehouseName}</option>)}
      </select></label>
      <label>Work area<select className={selectClass} value={stationId} disabled={!context} onChange={(event) => { setStationChoice(event.target.value); setBeforeId(null); setSelectedId(null); }}>
        <option value="">All permitted assembly areas</option>{context?.stations.map((station) => <option key={station.id} value={station.id}>{station.code} — {station.name}{station.enabled ? "" : " (paused)"}</option>)}
      </select></label>
    </div>
    {contexts.error && <p role="alert">{contexts.error.message} <Button onClick={() => contexts.refetch()}>Retry context</Button></p>}
    {contexts.data?.contexts.length === 0 && <p>No assembly area is available under your current warehouse scope. An authorized administrator must configure your access.</p>}
    {query.error && <p role="alert">{query.error.message} <Button onClick={() => query.refetch()}>Retry queue</Button></p>}
    <div className="grid gap-4 lg:grid-cols-[minmax(16rem,1fr)_2fr]">
      <section className="space-y-2" aria-label="Assembly queue">
        <h2 className="font-semibold">Jobs and recent assembly history</h2>
        {query.isFetching && <p className="text-sm">Refreshing…</p>}
        {query.data?.tasks.length === 0 && <p>No jobs on this page.</p>}
        {query.data?.tasks.map((task) => <button key={task.id} type="button" className={`w-full rounded border p-3 text-left ${selectedId === task.id ? "border-primary bg-muted" : "bg-card"}`} onClick={() => setSelectedId(task.id)}>
          <span className="block font-medium">{task.buildSystemNumber} · {task.station.code}</span>
          <span className="block text-sm">Order ID {task.orderId} · {task.state}{task.assignedTo === user?.id ? " · yours" : ""}</span>
          {task.blockedReason && <span className="block text-sm text-amber-700">{task.blockedReason}</span>}
        </button>)}
        <div className="flex gap-2"><Button variant="outline" disabled={!beforeId} onClick={() => setBeforeId(null)}>Newest</Button>
          <Button variant="outline" disabled={!query.data?.nextBeforeId} onClick={() => setBeforeId(query.data?.nextBeforeId ?? null)}>Older jobs</Button></div>
      </section>
      <section>{selectedId && user ? <JobDetail key={`${user.id}:${selectedId}`} id={selectedId} actorId={user.id} /> : <p>Select a job to preview its instructions. Previewing does not assign or start it.</p>}</section>
    </div>
    <Link href="/picking" className="text-sm underline">Return to Picking</Link>
  </main>;
}
