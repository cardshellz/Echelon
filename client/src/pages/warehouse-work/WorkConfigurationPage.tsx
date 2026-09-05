import React, { useRef, useState } from "react";
import { Link, useParams } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  WORK_CAPABILITIES, WORK_CAPABILITY_LABELS, smallTeamProfile,
  workRevisionSchema, workSetupSchema,
  type WorkSetup, type WorkConfiguration, type WorkCapability, type WorkProfile, type WorkRevision,
} from "@shared/warehouse-work";
import { prepareWorkSaveAttempt, type WorkSaveAttempt } from "./work-configuration-draft";

async function request(method: string, url: string, body?: unknown): Promise<unknown> {
  const response = await fetch(url, { method, credentials: "include",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const data: unknown = await response.json();
  if (!response.ok) {
    const error = z.object({ message: z.string(), code: z.string().optional() }).safeParse(data);
    throw new Error(error.success ? error.data.message : `Request failed (${response.status})`);
  }
  return data;
}

const selectClass = "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
function Capabilities({ value, onChange, disabled }: {
  value: WorkCapability[]; onChange: (next: WorkCapability[]) => void; disabled?: boolean;
}) {
  return <fieldset disabled={disabled} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
    <legend className="mb-2 text-sm font-medium">Capabilities</legend>
    {WORK_CAPABILITIES.map((capability) => <label key={capability} className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={value.includes(capability)} onChange={(event) => onChange(
        event.target.checked ? [...value, capability] : value.filter((entry) => entry !== capability),
      )} />{WORK_CAPABILITY_LABELS[capability]}
    </label>)}
  </fieldset>;
}

function ProfileSelect<K extends keyof Omit<WorkProfile, "handoff">>({ label, field, profile, options, onChange }: {
  label: string; field: K; profile: WorkProfile; options: Array<[WorkProfile[K], string]>;
  onChange: (profile: WorkProfile) => void;
}) {
  return <label className="space-y-1 text-sm font-medium">{label}
    <select className={selectClass} value={profile[field]} onChange={(event) => onChange({ ...profile, [field]: event.target.value })}>
      {options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
    </select>
  </label>;
}

export function ConfigurationEditor({ setup, url }: { setup: WorkSetup; url: string }) {
  const queryClient = useQueryClient();
  const [base, setBase] = useState(setup.revision);
  const [configuration, setConfiguration] = useState<WorkConfiguration>(setup.revision.configuration);
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const retry = useRef<WorkSaveAttempt | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);
  const history = useQuery({
    queryKey: [url, "history", historyCursor], enabled: historyOpen,
    queryFn: async () => z.array(workRevisionSchema).parse(await request("GET", `${url}/history${historyCursor === null ? "" : `?before=${historyCursor}`}`)),
  });
  const save = useMutation({
    mutationFn: async () => {
      // Preserve this command ID after a lost response. A second click is a retry,
      // not a new write. Editing after a lost response still meets the revision guard.
      retry.current = prepareWorkSaveAttempt({ expectedRevision: base.revision, configuration, reason }, retry.current, () => crypto.randomUUID());
      return workRevisionSchema.parse(await request("PUT", url, retry.current.command));
    },
    onSuccess: (revision) => {
      setBase(revision); setConfiguration(revision.configuration); setReason(""); retry.current = null;
      setNotice(`Draft revision ${revision.revision} saved. Live warehouse workflows are unchanged.`);
      void queryClient.invalidateQueries({ queryKey: [url] });
    },
  });
  const reload = useMutation({
    mutationFn: async () => workSetupSchema.parse(await request("GET", url)),
    onSuccess: (fresh) => {
      queryClient.setQueryData([url], fresh); setBase(fresh.revision); setConfiguration(fresh.revision.configuration);
      setReason(""); retry.current = null; setNotice("Reloaded the saved draft."); save.reset(); setLocalError(null);
    },
  });
  const dirty = JSON.stringify(configuration) !== JSON.stringify(base.configuration);
  const disabled = !setup.canConfigure || save.isPending || reload.isPending;
  const change = (next: WorkConfiguration) => { setConfiguration(next); setNotice(null); setLocalError(null); save.reset(); };
  const zones = [...new Set(setup.locations.filter((location) => location.active && location.zone).map((location) => location.zone!))].sort();

  return <div className="space-y-6">
    <div className="rounded-md border border-amber-400 bg-amber-50 p-4 text-sm text-amber-950" role="status">
      <strong>Draft setup — live execution not connected.</strong> You can prepare stations, workflows, and employee scopes here.
      Saving does not alter ATP, inventory, current roles, picking, replenishment posting, or shipping.
      Physical completion and real handoffs will remain required when execution is connected.
    </div>
    {setup.revision.revision > base.revision && <p role="alert" className="text-amber-700">A newer revision is available. Reload and review it before saving; your unsaved edits have been preserved.</p>}
    <fieldset disabled={disabled} className="space-y-6">
      <Card><CardHeader><CardTitle>Workflow profile</CardTitle></CardHeader><CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">One workflow per responsibility. One employee can receive, move, and stow without handing work to themselves.</p>
        <Button type="button" variant="outline" onClick={() => change({ ...configuration, profile: smallTeamProfile() })}>Use Small Team defaults</Button>
        <div className="grid gap-4 md:grid-cols-2">
          <ProfileSelect label="Inbound" field="inbound" profile={configuration.profile} onChange={(profile) => change({ ...configuration, profile })}
            options={[["receive_and_stow", "Receive & stow — same workflow"], ["staged", "Receive, then queue putaway"]]} />
          <ProfileSelect label="Replenishment responsibility" field="replenishment" profile={configuration.profile} onChange={(profile) => change({ ...configuration, profile })}
            options={[["same_operator", "Same operator — continue on the gun"], ["team_queue", "Dedicated replenishment queue"]]} />
          <ProfileSelect label="Assembly & packing" field="assemblyPacking" profile={configuration.profile} onChange={(profile) => change({ ...configuration, profile })}
            options={[["combined", "Combined station / operator"], ["separate", "Separate assembly and packing handoff"]]} />
          <ProfileSelect label="Work assignment" field="assignment" profile={configuration.profile} onChange={(profile) => change({ ...configuration, profile })}
            options={[["claim_on_start", "Claim when starting work"], ["dispatcher", "Supervisor dispatch"]]} />
        </div>
        <p className="text-sm text-muted-foreground">Replenishment rules still decide what moves and how it posts. These choices only describe who performs the work. Handoff evidence is required when responsibility changes, not for every activity.</p>
      </CardContent></Card>

      <Card><CardHeader><CardTitle>Physical stations</CardTitle></CardHeader><CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">Create real work areas, such as Assembly & Packing. Mobile picking, receiving, and stowing do not each need a station. A station is linked to a warehouse location; it does not create inventory.</p>
        {configuration.stations.length === 0 && <p>No stations configured. Add only the physical areas you need.</p>}
        {configuration.stations.map((station, index) => {
          const update = (patch: Partial<typeof station>) => change({ ...configuration, stations: configuration.stations.map((row) => row.id === station.id ? { ...row, ...patch } : row) });
          return <fieldset key={station.id} className="space-y-4 rounded-md border p-4">
            <legend className="px-2 font-medium">{station.name || `Station ${index + 1}`}</legend>
            <div className="grid gap-3 md:grid-cols-3">
              <label className="text-sm">Station code<Input value={station.code} maxLength={30} onChange={(event) => update({ code: event.target.value.toUpperCase() })} placeholder="ASSEMBLY-PACK" /></label>
              <label className="text-sm">Name<Input value={station.name} maxLength={100} onChange={(event) => update({ name: event.target.value })} /></label>
              <label className="text-sm">Physical location<select className={selectClass} value={station.locationId || ""} onChange={(event) => update({ locationId: Number(event.target.value) })}>
                <option value="">Select a location</option>
                {setup.locations.map((location) => <option key={location.id} value={location.id} disabled={!location.active}>{location.code}{location.active ? "" : " (inactive)"}</option>)}
              </select></label>
            </div>
            <Capabilities value={station.capabilities} onChange={(capabilities) => update({ capabilities })} />
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={station.enabled} onChange={(event) => update({ enabled: event.target.checked })} />Enabled in this draft</label>
            {!base.configuration.stations.some((row) => row.id === station.id) && <Button type="button" variant="outline" onClick={() => {
              if (configuration.access.some((access) => access.scope.kind === "stations" && access.scope.stationIds.includes(station.id))) {
                setLocalError("Remove this station from employee scopes before removing it."); return;
              }
              change({ ...configuration, stations: configuration.stations.filter((row) => row.id !== station.id) });
            }}>Remove unsaved station</Button>}
          </fieldset>;
        })}
        <Button type="button" variant="outline" disabled={configuration.stations.length >= 500} onClick={() => change({ ...configuration, stations: [...configuration.stations, {
          id: crypto.randomUUID(), code: "", name: "", locationId: 0, capabilities: ["assembly", "packing"], enabled: true,
        }] })}>Add physical station</Button>
      </CardContent></Card>

      <Card><CardHeader><CardTitle>Employee work scope</CardTitle></CardHeader><CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">A scope restricts where an employee may use their role capabilities. It does not grant role permissions. One employee can cover multiple activities. Configure role abilities in <Link href="/roles" className="underline">Roles</Link>.</p>
        <fieldset disabled={!setup.canManageAccess} className="space-y-4">
          {configuration.access.map((access) => {
            const update = (patch: Partial<typeof access>) => change({ ...configuration, access: configuration.access.map((row) => row.userId === access.userId ? { ...row, ...patch } : row) });
            return <fieldset key={access.userId} className="space-y-3 rounded-md border p-4">
              <legend className="px-2 font-medium">{setup.employees.find((employee) => employee.id === access.userId)?.name ?? access.userId}</legend>
              <Capabilities value={access.capabilities} onChange={(capabilities) => update({ capabilities })} />
              <label className="block text-sm">Allowed area<select className={selectClass} value={access.scope.kind} onChange={(event) => update({ scope:
                event.target.value === "stations" ? { kind: "stations", stationIds: [] } : event.target.value === "zone" ? { kind: "zone", zone: zones[0] ?? "" } : { kind: "warehouse" },
              })}><option value="warehouse">This entire warehouse (including mobile work)</option><option value="zone">One zone (including mobile work)</option><option value="stations">Specific physical stations only</option></select></label>
              {access.scope.kind === "zone" && <label className="block text-sm">Zone<select className={selectClass} value={access.scope.zone} onChange={(event) => update({ scope: { kind: "zone", zone: event.target.value } })}><option value="">Select zone</option>{zones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}</select></label>}
              {access.scope.kind === "stations" && <div className="space-y-2">{configuration.stations.map((station) => {
                const ids = access.scope.kind === "stations" ? access.scope.stationIds : [];
                return <label key={station.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={ids.includes(station.id)} onChange={(event) => update({ scope: { kind: "stations", stationIds: event.target.checked ? [...ids, station.id] : ids.filter((id) => id !== station.id) } })} />{station.name || station.code || "Unnamed station"}{station.enabled ? "" : " (disabled)"}</label>;
              })}</div>}
              <Button type="button" variant="outline" onClick={() => change({ ...configuration, access: configuration.access.filter((row) => row.userId !== access.userId) })}>Remove employee scope</Button>
            </fieldset>;
          })}
          <label className="block text-sm">Add employee<select className={selectClass} value="" onChange={(event) => {
            if (event.target.value) change({ ...configuration, access: [...configuration.access, { userId: event.target.value, capabilities: ["picking", "replenishment"], scope: { kind: "warehouse" } }] });
          }}><option value="">Select employee</option>{setup.employees.filter((employee) => employee.active && !configuration.access.some((access) => access.userId === employee.id)).map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label>
        </fieldset>
        {!setup.canManageAccess && <p className="text-sm">Managing employee scopes requires the separate Manage access permission.</p>}
      </CardContent></Card>
    </fieldset>

    <Card><CardContent className="space-y-3 pt-6">
      <p className="text-sm">Saved revision: {base.revision} · {dirty ? "Unsaved changes" : "No configuration changes"}</p>
      <label className="block text-sm">Reason for change<Input disabled={disabled} value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} placeholder="Explain this setup change (at least 5 characters)" /></label>
      {(localError || save.error || reload.error) && <p role="alert" className="text-sm text-destructive">{localError ?? (save.error instanceof z.ZodError ? save.error.issues.map((issue) => issue.message).join("; ") : save.error?.message) ?? reload.error?.message}</p>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={disabled || !dirty || reason.trim().length < 5} onClick={() => { setLocalError(null); save.mutate(); }}>{save.isPending ? "Saving…" : "Save draft setup"}</Button>
        <Button type="button" variant="outline" disabled={save.isPending || reload.isPending} onClick={() => {
          if (!dirty || window.confirm("Discard your unsaved edits and reload the saved setup?")) reload.mutate();
        }}>Reload saved setup</Button>
        <Button type="button" variant="outline" onClick={() => { setHistoryOpen(!historyOpen); setHistoryCursor(null); }}>Revision history</Button>
      </div>
      {historyOpen && <div className="space-y-3 border-t pt-3">
        {history.isLoading && <p>Loading history…</p>}{history.error && <p role="alert">{history.error.message}</p>}
        {history.data?.length === 0 && <p>No earlier revisions.</p>}
        {history.data?.map((revision: WorkRevision) => <details key={revision.revision} className="rounded border p-2">
          <summary className="cursor-pointer text-sm">Revision {revision.revision} · {revision.reason} · {setup.employees.find((employee) => employee.id === revision.savedBy)?.name ?? revision.savedBy} · {revision.savedAt}</summary>
          <pre className="mt-2 max-h-96 overflow-auto text-xs">{JSON.stringify(revision.configuration, null, 2)}</pre>
        </details>)}
        {history.data?.length === 20 && <Button type="button" variant="outline" onClick={() => setHistoryCursor(history.data![19].revision)}>Older revisions</Button>}
      </div>}
    </CardContent></Card>
  </div>;
}

export default function WorkConfigurationPage() {
  const { id } = useParams<{ id: string }>();
  const validId = /^[1-9]\d*$/.test(id ?? "") && Number(id) <= 2_147_483_647;
  const url = `/api/warehouses/${id}/work-configuration`;
  const setup = useQuery({ queryKey: [url], enabled: validId, queryFn: async () => workSetupSchema.parse(await request("GET", url)) });
  return <main className="mx-auto max-w-6xl space-y-6 p-4 md:p-6">
    <Link href={`/warehouse/settings/${id}`} className="text-sm underline">Back to warehouse settings</Link>
    <header><h1 className="text-2xl font-semibold">Stations & workflows</h1><p className="text-muted-foreground">{setup.data?.warehouse.name ?? "Warehouse setup"}</p></header>
    {!validId && <p role="alert">Choose a valid warehouse.</p>}
    {setup.isLoading && validId && <p>Loading warehouse setup…</p>}
    {setup.error && <p role="alert" className="text-destructive">{setup.error.message}</p>}
    {setup.data && <ConfigurationEditor key={id} setup={setup.data} url={url} />}
  </main>;
}
