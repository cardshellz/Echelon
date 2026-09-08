import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { inboundTrackingCommandResultSchema, inboundTrackingConfigSchema, inboundTrackingHistorySchema, inboundTrackingViewSchema, type InboundTrackingConfig, type InboundTrackingReference, type InboundTrackingSnapshot, type SaveInboundTracking } from "@shared/procurement/inbound-tracking";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";

const stamp = (value: string | null): string => value ? new Date(value).toLocaleString() : "Not yet recorded";
const providerLabel = (provider: string): string => provider === "searates" ? "SeaRates ocean tracking" : "ShipStation parcel tracking";
function Snapshot({ snapshot }: { snapshot: InboundTrackingSnapshot }) {
  const arrival = snapshot.arrival;
  const position = snapshot.vesselPosition;
  return <div className="space-y-4" data-testid="inbound-tracking-observation">
    <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{snapshot.status}</Badge><span className="text-sm text-muted-foreground">{snapshot.carrierName} · {snapshot.statusSource === "provider_calculated" ? "Status calculated by tracking provider" : snapshot.statusSource === "carrier" ? "Carrier status" : "Status source unknown"}</span></div>
    <dl className="grid gap-3 text-sm sm:grid-cols-2">
      <div><dt className="font-medium">Carrier data updated</dt><dd>{stamp(snapshot.sourceUpdatedAt)}</dd></div>
      <div><dt className="font-medium">{arrival?.kind === "port" ? "Destination port arrival" : "Carrier destination arrival"}</dt><dd>{arrival ? <>{arrival.dateText} {arrival.timezone ?? (arrival.occurredAt ? "" : "(timezone not provided)")} · {arrival.actual === true ? "Actual" : arrival.actual === false ? "Estimated" : "Date certainty unknown"}{arrival.location ? ` · ${arrival.location}` : ""}</> : "No arrival date provided"}</dd></div>
    </dl>
    {snapshot.fromCache === true && <p className="text-sm text-muted-foreground">The provider returned cached carrier data.</p>}
    {position ? <div className="rounded border p-3 text-sm"><p className="font-medium">Reported vessel position{position.vessel ? ` · ${position.vessel}` : ""}</p><p>{position.latitude.toFixed(5)}, {position.longitude.toFixed(5)} · Observed {stamp(position.observedAt)}</p><a className="underline" href={`https://www.openstreetmap.org/?mlat=${position.latitude}&mlon=${position.longitude}#map=5/${position.latitude}/${position.longitude}`} target="_blank" rel="noopener noreferrer">Open reported vessel position on map</a></div> : snapshot.positionStatus && <p className="text-sm text-muted-foreground">Vessel position: {snapshot.positionStatus.replaceAll("_", " ").toLowerCase()}.</p>}
    <details open><summary className="cursor-pointer font-medium">Carrier timeline ({snapshot.events.length})</summary>
      {snapshot.events.length === 0 ? <p className="py-2 text-sm text-muted-foreground">No carrier events provided.</p> : <ol className="mt-3 space-y-3 border-l pl-4" aria-label="Carrier tracking events">
        {[...snapshot.events].reverse().map((event) => <li key={event.key} className="space-y-1 text-sm">
          <p className="font-medium">{event.description} <Badge variant="outline">{event.actual === true ? "Actual" : event.actual === false ? "Estimated" : "Certainty unknown"}</Badge></p>
          <p>{event.dateText ?? "Date not supplied"}{event.timezone ? ` · ${event.timezone}` : event.occurredAt ? "" : " · Timezone not supplied"}</p>
          <p className="text-muted-foreground">{[event.container, event.location, event.vessel, event.voyage ? `Voyage ${event.voyage}` : null].filter(Boolean).join(" · ") || "Location not supplied"}</p>
          {(event.source !== "carrier" || event.mirrored) && <p className="text-muted-foreground">{event.source === "provider_calculated" ? "Date calculated by provider. " : event.source === "unknown" ? "Date source unknown. " : ""}{event.mirrored ? "Event copied by provider from another container." : ""}</p>}
        </li>)}
      </ol>}
    </details>
  </div>;
}
function History({ baseUrl, referenceId }: { baseUrl: string; referenceId: number }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const query = useQuery({ queryKey: [baseUrl, referenceId, "history", cursor], queryFn: async () => inboundTrackingHistorySchema.parse(await (await apiRequest("GET", `${baseUrl}/${referenceId}/history${cursor ? `?beforeId=${cursor}` : ""}`)).json()) });
  if (query.isPending) return <p role="status">Loading tracking history…</p>;
  if (query.isError) return <div role="alert">Tracking history could not be loaded. <Button variant="outline" onClick={() => query.refetch()}>Retry history</Button></div>;
  const data = query.data;
  return <div className="mt-3 space-y-4 rounded border p-3">
    <p className="font-medium">Retained observations</p>
    {data.observations.length === 0 && <p className="text-sm">No observations retained yet.</p>}
    {data.observations.map((observation) => <div key={observation.id}><Button className="h-auto whitespace-normal text-left" variant="ghost" onClick={() => setSelected(selected === observation.id ? null : observation.id)}>Observed {stamp(observation.observedAt)} · {observation.snapshot.status}</Button>{selected === observation.id && <Snapshot snapshot={observation.snapshot} />}</div>)}
    {data.nextObservationCursor && <Button variant="outline" onClick={() => { setSelected(null); setCursor(data.nextObservationCursor); }}>Older observations</Button>}
    {cursor && <Button variant="outline" onClick={() => { setSelected(null); setCursor(null); }}>Latest observations</Button>}
    <details><summary className="cursor-pointer">Recent refresh attempts ({data.attempts.length})</summary><ul className="mt-2 space-y-2 text-sm">{data.attempts.map((attempt, index) => <li key={`${attempt.startedAt}:${index}`}>{stamp(attempt.startedAt)} · {attempt.outcome.replaceAll("_", " ")}{attempt.message ? ` · ${attempt.message}` : ""}</li>)}</ul></details>
    <details><summary className="cursor-pointer">Recent configuration changes ({data.changes.length})</summary><ul className="mt-2 space-y-2 text-sm">{data.changes.map((change) => <li key={change.revision}>Revision {change.revision} · {stamp(change.recordedAt)} · {change.actorId} · {change.after.enabled ? "Tracking enabled" : "Tracking paused"}{change.after.includeVesselPosition ? " · AIS requested" : ""}</li>)}</ul></details>
  </div>;
}
interface Props { shipmentId: number; shipmentStatus: string; containerNumber?: string | null; trackingNumber?: string | null; bolNumber?: string | null; bookingReference?: string | null; }
interface PendingCommand { method: "PUT" | "POST"; url: string; body: SaveInboundTracking | { requestKey: string }; }

export function InboundShipmentTracking(props: Props) {
  const { hasPermission } = useAuth();
  const client = useQueryClient();
  const baseUrl = `/api/inbound-shipments/${props.shipmentId}/tracking`;
  const [form, setForm] = useState({ provider: "searates", referenceType: "container", reference: props.containerNumber ?? "", carrierCode: "", enabled: true, includeVesselPosition: false });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [historyId, setHistoryId] = useState<number | null>(null);
  const mounted = useRef(true);
  const pending = useRef<PendingCommand | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const query = useQuery({ queryKey: [baseUrl], queryFn: async () => inboundTrackingViewSchema.parse(await (await apiRequest("GET", baseUrl)).json()), refetchInterval: 15_000 });
  const mutable = hasPermission("purchasing", "edit") && !["closed", "cancelled"].includes(props.shipmentStatus);
  const mutation = useMutation({
    mutationFn: async (command: PendingCommand) => {
      pending.current = command;
      inboundTrackingCommandResultSchema.parse(await (await apiRequest(command.method, command.url, command.body)).json());
    },
    onSuccess: async () => {
      pending.current = null;
      await client.invalidateQueries({ queryKey: [baseUrl] });
      if (mounted.current) { setError(null); setNotice("Tracking request saved. Provider updates appear here after the next enabled refresh."); }
    },
    onError: (cause) => { if (mounted.current) { setError(cause instanceof Error ? cause.message : "Tracking request failed. Retry the same request."); setNotice(null); } },
  });
  function save(config: InboundTrackingConfig, existing: InboundTrackingReference | null = null): void {
    setError(null); setNotice(null);
    mutation.mutate({ method: "PUT", url: baseUrl, body: { requestKey: crypto.randomUUID(), referenceId: existing?.id ?? null, expectedRevision: existing?.revision ?? 0, config } });
  }
  function add(): void {
    const parsed = inboundTrackingConfigSchema.safeParse({ identity: { provider: form.provider, referenceType: form.referenceType, reference: form.reference, carrierCode: form.carrierCode }, enabled: form.enabled, includeVesselPosition: form.includeVesselPosition });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? "Check the tracking reference."); return; }
    save(parsed.data);
  }
  if (query.isPending) return <p role="status">Loading shipment tracking…</p>;
  if (query.isError) return <Card><CardContent className="space-y-3 pt-6"><p role="alert">Shipment tracking could not be loaded. Operational shipment details remain available.</p><Button variant="outline" onClick={() => query.refetch()}>Retry tracking</Button></CardContent></Card>;
  const data = query.data;
  return <div className="space-y-4" data-testid="inbound-shipment-tracking">
    <Card><CardHeader><CardTitle>Carrier and container tracking</CardTitle></CardHeader><CardContent className="space-y-3">
      <p className="text-sm">Follow each parcel, container, bill of lading or booking here. Carrier delivery and port arrival do not receive inventory or make it available for sale. Warehouse receiving and putaway determine availability.</p>
      {!data.pollingEnabled && <p role="status" className="rounded border border-amber-300 p-3 text-sm">Tracking refresh is paused in deployment settings. References and history can be prepared now; a system administrator must enable the polling service.</p>}
      {data.providers.map((provider) => <div key={provider.provider} className="text-sm"><span className="font-medium">{providerLabel(provider.provider)}: </span>{provider.configured ? "Credentials configured; carrier access is verified when a refresh succeeds." : "Credentials required."}{!provider.configured && <p className="text-muted-foreground">{provider.provider === "searates" ? "Connect a SeaRates Container Tracking subscription through your system administrator. Vessel position also requires AIS access." : "Ask your system administrator to configure the ShipStation account and enable tracking for the selected carrier."}</p>}</div>)}
      <p className="text-xs text-muted-foreground">Active references refresh about every six hours. Manual refresh requests are limited to one every five minutes. Provider availability and account limits may delay updates.</p>
    </CardContent></Card>
    {error && <div role="alert" className="space-y-2 rounded border border-destructive p-3 text-sm"><p>{error}</p>{pending.current && <Button variant="outline" disabled={mutation.isPending} onClick={() => mutation.mutate(pending.current!)}>Retry same tracking request</Button>}</div>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {data.references.length === 0 && <p className="text-sm text-muted-foreground">No tracking references linked yet.</p>}
    {data.references.map((reference) => {
      const ready = data.providers.find((provider) => provider.provider === reference.config.identity.provider)?.configured === true;
      return <Card key={reference.id}><CardHeader><CardTitle className="flex flex-wrap items-center gap-2 text-base"><span className="break-all">{reference.config.identity.reference}</span><Badge variant="secondary">{reference.config.identity.referenceType.replaceAll("_", " ")}</Badge>{!reference.config.enabled && <Badge variant="outline">Paused</Badge>}</CardTitle><p className="text-sm text-muted-foreground">{providerLabel(reference.config.identity.provider)}{reference.config.identity.carrierCode ? ` · ${reference.config.identity.carrierCode}` : ""}</p></CardHeader><CardContent className="space-y-4">
        <dl className="grid gap-3 text-sm sm:grid-cols-3"><div><dt className="font-medium">Last refresh attempt</dt><dd>{stamp(reference.lastAttemptAt)}</dd></div><div><dt className="font-medium">Last successful response</dt><dd>{stamp(reference.lastSuccessAt)}</dd></div><div><dt className="font-medium">Next refresh due</dt><dd>{reference.config.enabled && data.pollingEnabled && ready ? stamp(reference.nextPollAt) : "Paused or awaiting setup"}</dd></div></dl>
        {reference.lastErrorMessage && <p role="alert" className="rounded border border-amber-300 p-3 text-sm">{reference.reviewRequired ? "Review required: " : "Refresh notice: "}{reference.lastErrorMessage} {reference.failureCount > 0 ? `(${reference.failureCount} failed attempts)` : ""}</p>}
        {reference.current ? <Snapshot snapshot={reference.current} /> : <p className="text-sm text-muted-foreground">No carrier observation received. The shipment's operational status remains {props.shipmentStatus.replaceAll("_", " ")}.</p>}
        <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => setHistoryId(historyId === reference.id ? null : reference.id)}>{historyId === reference.id ? "Hide retained history" : "View retained history"}</Button>
          {mutable && <><Button variant="outline" disabled={mutation.isPending || !ready || !data.pollingEnabled || !reference.config.enabled} onClick={() => mutation.mutate({ method: "POST", url: `${baseUrl}/${reference.id}/refresh`, body: { requestKey: crypto.randomUUID() } })}>Request refresh</Button><Button variant="outline" disabled={mutation.isPending} onClick={() => save({ ...reference.config, enabled: !reference.config.enabled }, reference)}>{reference.config.enabled ? "Pause tracking" : "Resume tracking"}</Button>{reference.config.identity.provider === "searates" && <Button variant="outline" disabled={mutation.isPending} onClick={() => save({ ...reference.config, includeVesselPosition: !reference.config.includeVesselPosition }, reference)}>{reference.config.includeVesselPosition ? "Stop requesting vessel position" : "Request vessel position"}</Button>}</>}
        </div>
        {historyId === reference.id && <History key={reference.id} baseUrl={baseUrl} referenceId={reference.id} />}
      </CardContent></Card>;
    })}
    {mutable && <Card><CardHeader><CardTitle className="text-base">Add tracking reference</CardTitle></CardHeader><CardContent className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor="tracking-provider">Tracking provider</Label><select id="tracking-provider" className="h-10 w-full rounded border bg-background px-3 text-sm" value={form.provider} disabled={mutation.isPending} onChange={(event) => setForm({ ...form, provider: event.target.value, referenceType: event.target.value === "shipstation" ? "parcel" : "container", reference: (event.target.value === "shipstation" ? props.trackingNumber : props.containerNumber) ?? "", carrierCode: "", includeVesselPosition: false })}><option value="searates">SeaRates — ocean containers</option><option value="shipstation">ShipStation — parcels</option></select></div>
        <div className="space-y-2"><Label htmlFor="tracking-reference-type">Reference type</Label><select id="tracking-reference-type" className="h-10 w-full rounded border bg-background px-3 text-sm" value={form.referenceType} disabled={mutation.isPending || form.provider === "shipstation"} onChange={(event) => setForm({ ...form, referenceType: event.target.value, reference: (event.target.value === "container" ? props.containerNumber : event.target.value === "bill_of_lading" ? props.bolNumber : props.bookingReference) ?? "" })}>{form.provider === "shipstation" ? <option value="parcel">Parcel tracking number</option> : <><option value="container">Container number</option><option value="bill_of_lading">Bill of lading</option><option value="booking">Booking number</option></>}</select></div>
        <div className="space-y-2"><Label htmlFor="tracking-reference">Tracking reference</Label><Input id="tracking-reference" value={form.reference} maxLength={100} disabled={mutation.isPending} onChange={(event) => setForm({ ...form, reference: event.target.value })} /></div>
        <div className="space-y-2"><Label htmlFor="tracking-carrier">{form.provider === "searates" ? "Shipping line SCAC (optional)" : "ShipStation carrier code"}</Label><Input id="tracking-carrier" value={form.carrierCode} maxLength={100} disabled={mutation.isPending} placeholder={form.provider === "searates" ? "Leave blank to detect" : "e.g. ups"} onChange={(event) => setForm({ ...form, carrierCode: event.target.value })} /></div>
      </div>
      <div className="flex items-center gap-2"><Checkbox id="tracking-enabled" checked={form.enabled} disabled={mutation.isPending} onCheckedChange={(checked) => setForm({ ...form, enabled: checked === true })} /><Label htmlFor="tracking-enabled">Enable scheduled refresh when the provider is connected</Label></div>
      {form.provider === "searates" && <div className="flex items-center gap-2"><Checkbox id="tracking-position" checked={form.includeVesselPosition} disabled={mutation.isPending} onCheckedChange={(checked) => setForm({ ...form, includeVesselPosition: checked === true })} /><Label htmlFor="tracking-position">Include vessel AIS position (requires provider access)</Label></div>}
      <Button disabled={mutation.isPending || data.references.length >= 20} onClick={add}>Add tracking reference</Button>
      <p className="text-xs text-muted-foreground">Tracking numbers stay attached to their history. To correct a number, pause its reference and add the corrected number.</p>
    </CardContent></Card>}
  </div>;
}
