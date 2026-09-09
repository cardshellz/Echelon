import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  FulfillmentChannel,
  PackagingConfiguration,
} from "@shared/shipping/configuration";
import { fulfillmentChannelSchema } from "@shared/shipping/configuration";
import {
  invalidateShippingAdmin,
  postJson,
  putJson,
} from "./pricing-programs/api";
import {
  channelLabels,
  useConfigurationCommand,
  usePackagingConfiguration,
} from "./configuration-client";

export function PackagingAssignmentEditor({
  data,
  channel,
  warehouseId,
  dropship = false,
  onSaved,
  onClose,
}: {
  data: PackagingConfiguration;
  channel: FulfillmentChannel;
  warehouseId: number | null;
  dropship?: boolean;
  onSaved: () => Promise<unknown>;
  onClose: () => void;
}) {
  const [openedData] = useState(data);
  const assignment = openedData.assignments.find(
    (a) => a.channel === channel && a.warehouseId === warehouseId,
  );
  const fallback = openedData.assignments.find(
    (a) => a.channel === channel && a.warehouseId === null,
  );
  const initial = assignment
    ? String(assignment.suiteId)
    : warehouseId === null
      ? ""
      : "inherit";
  const [suite, setSuite] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const client = useQueryClient();
  const commandFor = useConfigurationCommand();
  const scope =
    warehouseId === null
      ? "Channel default"
      : (data.warehouses.find((w) => w.id === warehouseId)?.name ??
        `Warehouse ${warehouseId}`);
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value && !busy) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit packaging assignment</DialogTitle>
        </DialogHeader>
        <p>
          {channelLabels[channel]} · {scope}
        </p>
        <label className="grid gap-2 text-sm">
          Box suite
          <select
            aria-label="Assigned box suite"
            className="h-10 w-full rounded border bg-background px-2"
            value={suite}
            disabled={busy}
            onChange={(e) => {
              setSuite(e.target.value);
              setError("");
            }}
          >
            {warehouseId === null ? (
              <option value="" disabled>
                Choose suite
              </option>
            ) : (
              <option value="inherit" disabled={!fallback}>
                Use channel default —{" "}
                {data.suites.find((s) => s.id === fallback?.suiteId)?.name ??
                  "Not configured"}
              </option>
            )}
            {data.suites
              .filter((s) => !s.archived)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </label>
        <p className="text-sm text-muted-foreground">
          {warehouseId === null
            ? "Used wherever this channel has no warehouse override."
            : "This changes packaging at this warehouse only. It does not enable or disable fulfillment from the warehouse."}
        </p>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button
            disabled={busy || !suite || suite === initial}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const body = {
                  channel,
                  warehouseId,
                  expectedRevision: assignment?.revision ?? 0,
                  ...(suite === "inherit" ? {} : { suiteId: Number(suite) }),
                };
                const endpoint = dropship
                  ? "/api/dropship/admin/shipping/shared/packaging"
                  : "/api/shipping/admin/packaging/assignment";
                if (suite === "inherit")
                  await postJson(`${endpoint}/reset`, {
                    ...body,
                    commandId: commandFor(body),
                  });
                else
                  await putJson(endpoint, {
                    ...body,
                    commandId: commandFor(body),
                  });
                invalidateShippingAdmin(client);
                await onSaved();
                onClose();
              } catch (e) {
                setError(
                  e instanceof Error ? e.message : "Unable to save assignment.",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Saving…" : "Save assignment"}
          </Button>
          <Button disabled={busy} variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function PackagingAssignmentsPanel() {
  const query = usePackagingConfiguration();
  const requested = fulfillmentChannelSchema.safeParse(
    new URLSearchParams(location.search).get("profile"),
  );
  const [channel, setChannel] = useState<FulfillmentChannel>(
    requested.success ? requested.data : "dropship",
  );
  const [editing, setEditing] = useState<{ warehouseId: number | null } | null>(
    null,
  );
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [message, setMessage] = useState("");
  const data = query.data;
  if (!data)
    return (
      <p role={query.isError ? "alert" : undefined}>
        {query.isLoading
          ? "Loading packaging assignments…"
          : "Unable to load assignments."}
        <Button variant="outline" onClick={() => query.refetch()}>
          Refresh
        </Button>
      </p>
    );
  const assignments = data.assignments.filter((a) => a.channel === channel);
  const fallback = assignments.find((a) => a.warehouseId === null);
  const suiteName = (id?: number) =>
    data.suites.find((s) => s.id === id)?.name ?? "Not configured";
  const matches = data.warehouses.filter((w) =>
    w.name.toLowerCase().includes(search.toLowerCase()),
  );
  const totalPages = Math.max(1, Math.ceil(matches.length / 50));
  const currentPage = Math.min(page, totalPages - 1);
  const edit = (warehouseId: number | null) => {
    setMessage("");
    setEditing({ warehouseId });
  };
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Packaging assignments</h2>
        <p className="text-sm text-muted-foreground">
          Choose a default suite for a fulfillment channel, with warehouse
          exceptions where needed. These assignments do not control warehouse
          eligibility.
        </p>
      </div>
      <label className="grid max-w-sm gap-1 text-sm">
        Fulfillment channel
        <select
          className="h-10 rounded border bg-background px-2"
          value={channel}
          onChange={(e) => {
            setChannel(fulfillmentChannelSchema.parse(e.target.value));
            setMessage("");
            setPage(0);
          }}
        >
          {fulfillmentChannelSchema.options.map((c) => (
            <option key={c} value={c}>
              {channelLabels[c]}
            </option>
          ))}
        </select>
      </label>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded border p-4">
        <div>
          <h3 className="font-medium">{channelLabels[channel]} default</h3>
          <p>{suiteName(fallback?.suiteId)}</p>
          <p className="text-xs text-muted-foreground">
            Applies to every warehouse without an override.
          </p>
        </div>
        <Button variant="outline" onClick={() => edit(null)}>
          Edit default
        </Button>
      </div>
      {message && (
        <p role="status" className="text-emerald-700">
          {message}
        </p>
      )}
      <Input
        className="max-w-sm"
        aria-label="Search warehouses"
        placeholder="Search warehouses"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setPage(0);
        }}
      />
      <div className="max-h-[28rem] overflow-auto rounded border">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-background">
            <tr className="border-b">
              <th className="p-3">Warehouse</th>
              <th className="p-3">Effective suite</th>
              <th className="hidden p-3 md:table-cell">Source</th>
              <th className="p-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {matches
              .slice(currentPage * 50, (currentPage + 1) * 50)
              .map((w) => {
                const assigned = assignments.find(
                  (a) => a.warehouseId === w.id,
                );
                return (
                  <tr className="border-b last:border-0" key={w.id}>
                    <td className="p-3">{w.name}</td>
                    <td className="p-3">
                      {suiteName((assigned ?? fallback)?.suiteId)}
                      <div className="text-xs text-muted-foreground md:hidden">
                        {assigned ? "Warehouse override" : "Channel default"}
                      </div>
                    </td>
                    <td className="hidden p-3 md:table-cell">
                      {assigned ? "Warehouse override" : "Channel default"}
                    </td>
                    <td className="p-3 text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`Edit ${w.name} packaging`}
                        onClick={() => edit(w.id)}
                      >
                        Edit
                      </Button>
                    </td>
                  </tr>
                );
              })}
            {!matches.length && (
              <tr>
                <td className="p-3" colSpan={4}>
                  No warehouses match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            Previous
          </Button>
          <span>
            Page {currentPage + 1} of {totalPages}
          </span>
          <Button
            variant="outline"
            disabled={currentPage + 1 >= totalPages}
            onClick={() => setPage(currentPage + 1)}
          >
            Next
          </Button>
        </div>
      )}
      {editing && (
        <PackagingAssignmentEditor
          data={data}
          channel={channel}
          warehouseId={editing.warehouseId}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            await query.refetch({ throwOnError: true });
            setMessage("Packaging assignment saved.");
          }}
        />
      )}
    </section>
  );
}
