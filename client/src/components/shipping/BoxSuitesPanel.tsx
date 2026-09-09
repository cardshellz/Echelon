import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  getJson,
  postJson,
  putJson,
  invalidateShippingAdmin,
} from "./pricing-programs/api";
import {
  packagingConfigurationSchema,
  type BoxSuiteSummary,
  type FulfillmentChannel,
} from "@shared/shipping/configuration";
import { ConfigurationHistory } from "./ConfigurationHistory";

export function useConfigurationCommand() {
  const command = useRef<{ body: string; id: string } | undefined>(undefined);
  return (body: unknown) => {
    const serialized = JSON.stringify(body);
    if (command.current?.body !== serialized)
      command.current = { body: serialized, id: crypto.randomUUID() };
    return command.current.id;
  };
}
const fieldClass = "h-9 rounded-md border bg-background px-3 text-sm";
export function BoxSuitesPanel({
  channelOnly,
}: {
  channelOnly?: FulfillmentChannel;
}) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["/api/shipping/admin/packaging"],
    queryFn: async () =>
      packagingConfigurationSchema.parse(
        await getJson("/api/shipping/admin/packaging"),
      ),
  });
  const [editing, setEditing] = useState<BoxSuiteSummary | null>();
  const [name, setName] = useState("");
  const [boxIds, setBoxIds] = useState<number[]>([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [channel, setChannel] = useState<FulfillmentChannel>(
    channelOnly ?? "dropship",
  );
  const [warehouse, setWarehouse] = useState("");
  const [suite, setSuite] = useState("");
  const commandFor = useConfigurationCommand();
  const data = query.data;
  async function save(task: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await task();
      invalidateShippingAdmin(client);
      await query.refetch({ throwOnError: true });
      setEditing(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save packaging.");
    } finally {
      setBusy(false);
    }
  }
  if (query.isLoading) return <p>Loading packaging suites…</p>;
  if (!data)
    return (
      <p role="alert">
        Unable to load packaging.{" "}
        <Button variant="outline" onClick={() => query.refetch()}>
          Retry
        </Button>
      </p>
    );
  const assignments = data.assignments.filter(
    (a) => !channelOnly || a.channel === channelOnly,
  );
  const matchingAssignment = data.assignments.find(
    (a) =>
      a.channel === channel &&
      a.warehouseId === (warehouse ? Number(warehouse) : null),
  );
  const affected = editing
    ? data.assignments.filter((a) => a.suiteId === editing.id)
    : [];
  const open = (value: BoxSuiteSummary | null) => {
    setEditing(value);
    setName(value?.name ?? "");
    setBoxIds(value?.boxIds ?? []);
    setSearch("");
    setError("");
  };
  return (
    <section className="space-y-4 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold">Box suites</h3>
          <p className="text-sm text-muted-foreground">
            Reusable packaging choices. A warehouse override replaces the
            channel default; only boxes available there can be used.
          </p>
        </div>
        {!channelOnly && (
          <Button variant="outline" onClick={() => open(null)}>
            New suite
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!channelOnly && (
        <div className="max-h-60 overflow-auto divide-y rounded border">
          {data.suites.map((s) => (
            <div
              key={s.id}
              className="flex items-center justify-between gap-3 p-2 text-sm"
            >
              <span>
                {s.name}{" "}
                <span className="text-muted-foreground">
                  · {s.boxIds.length} boxes · revision {s.revision}
                </span>
              </span>
              <Button size="sm" variant="outline" onClick={() => open(s)}>
                Edit
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="max-h-60 overflow-auto rounded border">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b">
              <th className="p-2">Channel</th>
              <th>Warehouse</th>
              <th>Suite</th>
            </tr>
          </thead>
          <tbody>
            {assignments.map((a) => (
              <tr
                className="border-b last:border-0"
                key={`${a.channel}:${a.warehouseId}`}
              >
                <td className="p-2">{a.channel}</td>
                <td>
                  {data.warehouses.find((w) => w.id === a.warehouseId)?.name ??
                    "Channel default"}
                </td>
                <td>
                  {data.suites.find((s) => s.id === a.suiteId)?.name ??
                    "Unavailable"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const body = {
            channel,
            warehouseId: warehouse ? Number(warehouse) : null,
            suiteId: Number(suite),
            expectedRevision: matchingAssignment?.revision ?? 0,
          };
          void save(() =>
            putJson("/api/shipping/admin/packaging/assignment", {
              ...body,
              commandId: commandFor(body),
            }),
          );
        }}
      >
        {!channelOnly && (
          <label className="grid gap-1 text-sm">
            Channel
            <select
              className={fieldClass}
              value={channel}
              onChange={(e) => setChannel(e.target.value as FulfillmentChannel)}
            >
              {["dropship", "shopify", "internal", "ebay"].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
        )}
        <label className="grid gap-1 text-sm">
          Warehouse
          <select
            className={fieldClass}
            value={warehouse}
            onChange={(e) => setWarehouse(e.target.value)}
          >
            <option value="">Channel default</option>
            {data.warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          Suite
          <select
            required
            className={fieldClass}
            value={suite}
            onChange={(e) => setSuite(e.target.value)}
          >
            <option value="">Choose suite</option>
            {data.suites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <Button
          type="submit"
          disabled={
            busy || !suite || matchingAssignment?.suiteId === Number(suite)
          }
        >
          Save assignment
        </Button>
      </form>
      <Dialog
        open={editing !== undefined}
        onOpenChange={(value) => {
          if (!value && !busy) setEditing(undefined);
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editing ? "Edit box suite" : "New box suite"}
            </DialogTitle>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              const body = {
                ...(editing ? { id: editing.id } : {}),
                name,
                boxIds: [...boxIds].sort((a, b) => a - b),
                expectedRevision: editing?.revision ?? 0,
              };
              void save(() =>
                postJson("/api/shipping/admin/box-suites", {
                  ...body,
                  commandId: commandFor(body),
                }),
              );
            }}
          >
            <label className="grid gap-1 text-sm">
              Suite name
              <Input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <Input
              aria-label="Search boxes"
              placeholder="Search boxes"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="max-h-64 overflow-auto rounded border p-2">
              {data.boxes
                .filter((b) =>
                  `${b.code} ${b.name}`
                    .toLowerCase()
                    .includes(search.toLowerCase()),
                )
                .map((b) => (
                  <label
                    key={b.id}
                    className="flex items-center gap-2 py-1 text-sm"
                  >
                    <input
                      type="checkbox"
                      disabled={!b.isActive && !boxIds.includes(b.id)}
                      checked={boxIds.includes(b.id)}
                      onChange={(e) =>
                        setBoxIds(
                          e.target.checked
                            ? [...boxIds, b.id]
                            : boxIds.filter((id) => id !== b.id),
                        )
                      }
                    />
                    {b.name} · {b.code}
                    {!b.isActive && " (inactive)"}
                  </label>
                ))}
            </div>
            <p className="text-sm text-muted-foreground">
              {boxIds.length} boxes selected.{" "}
              {affected.length
                ? `Saving affects ${affected.length} channel/warehouse assignments: ${affected.map((a) => `${a.channel} / ${data.warehouses.find((w) => w.id === a.warehouseId)?.name ?? "default"}`).join(", ")}.`
                : "No channel assignments currently use this suite."}{" "}
              Existing shipment snapshots stay unchanged.
            </p>
            {editing && (
              <ConfigurationHistory resourceKey={`suite:${editing.id}`} />
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <Button disabled={busy || !boxIds.length} type="submit">
                Save suite
              </Button>
              <Button
                disabled={busy}
                type="button"
                variant="outline"
                onClick={() => setEditing(undefined)}
              >
                Cancel
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
