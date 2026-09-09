import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { dropshipSharedShippingConfigSchema } from "@shared/shipping/configuration";
import {
  getJson,
  putJson,
  invalidateShippingAdmin,
} from "./pricing-programs/api";
import { useConfigurationCommand } from "./configuration-client";
import { PackagingAssignmentEditor } from "./PackagingAssignmentsPanel";
import { DropshipProgramEditor } from "./DropshipProgramEditor";

export function DropshipSharedShippingPanel() {
  const query = useQuery({
    queryKey: ["/api/dropship/admin/shipping/shared"],
    queryFn: async () =>
      dropshipSharedShippingConfigSchema.parse(
        await getJson("/api/dropship/admin/shipping/shared"),
      ),
  });
  const client = useQueryClient();
  const [editing, setEditing] = useState<{
    part: "program" | "packaging";
    warehouseId: number | null;
  } | null>(null);
  const [service, setService] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const commandFor = useConfigurationCommand();
  const data = query.data;
  if (!data)
    return (
      <p role={query.isError ? "alert" : undefined}>
        {query.isLoading
          ? "Loading shared shipping configuration…"
          : "Unable to load shipping configuration."}
        <Button variant="outline" onClick={() => query.refetch()}>
          Refresh
        </Button>
      </p>
    );
  const selectedService = service ?? String(data.selectedService?.id ?? "");
  const packaging = data.packaging.assignments.filter(
    (a) => a.channel === "dropship",
  );
  const defaultSuite = packaging.find((a) => a.warehouseId === null);
  const defaultProgram = data.assignments.find((a) => a.warehouseId === null);
  const matches = data.packaging.warehouses.filter((w) =>
    w.name.toLowerCase().includes(search.toLowerCase()),
  );
  const totalPages = Math.max(1, Math.ceil(matches.length / 50));
  const currentPage = Math.min(page, totalPages - 1);
  const rows = [
    { id: null, name: "Channel default" },
    ...matches.slice(currentPage * 50, (currentPage + 1) * 50),
  ];
  const edit = (part: "program" | "packaging", warehouseId: number | null) => {
    setMessage("");
    setError("");
    setEditing({ part, warehouseId });
  };
  const refreshed = async () => {
    await query.refetch({ throwOnError: true });
    setMessage(
      "Assignment saved. Updated values are shown below and in shared Shipping Settings.",
    );
  };
  return (
    <section className="space-y-5 rounded-lg border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Dropship shipping</h2>
          <p className="text-sm text-muted-foreground">
            Shared pricing and packaging, with channel defaults and warehouse
            overrides.
          </p>
        </div>
        <Button
          disabled={busy}
          variant="outline"
          onClick={async () => {
            setMessage("");
            setError("");
            try {
              invalidateShippingAdmin(client);
              await query.refetch({ throwOnError: true });
            } catch {
              setError("Could not refresh shipping configuration.");
            }
          }}
        >
          Refresh
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-emerald-700">
          {message}
        </p>
      )}
      {(data.runtimeConfigurationError ||
        (data.runtimeMode && data.runtimeMode !== "live")) && (
        <p
          role="alert"
          className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"
        >
          {data.runtimeConfigurationError ??
            `Deployment shipping mode is ${data.runtimeMode}. Some stores still use preserved legacy rates.`}
        </p>
      )}
      <div className="space-y-3">
        <h3 className="font-medium">Pricing and packaging assignments</h3>
        <p className="text-sm text-muted-foreground">
          Each warehouse can have its own program and suite, or inherit the
          channel default. This table does not enable warehouses for
          fulfillment.
        </p>
        {data.configuredChannelId && (
          <p className="text-sm">
            Pricing uses versioned channel routing, including destination rules.{" "}
            <a
              className="underline"
              href="/shipping-settings?tab=channel-routing"
            >
              Edit pricing routing
            </a>
          </p>
        )}
        <Input
          className="max-w-sm"
          aria-label="Search assignment warehouses"
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
                <th className="p-3">Pricing program</th>
                <th className="p-3">Box suite</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => {
                const programAssignment = data.assignments.find(
                  (a) => a.warehouseId === w.id,
                );
                const program = data.programs.find(
                  (p) =>
                    p.id === (programAssignment ?? defaultProgram)?.rateBookId,
                );
                const suiteAssignment = packaging.find(
                  (a) => a.warehouseId === w.id,
                );
                const suite = data.packaging.suites.find(
                  (s) => s.id === (suiteAssignment ?? defaultSuite)?.suiteId,
                );
                const routingNames = data.programs.filter((p) =>
                  data.assignments.some(
                    (a) =>
                      (a.warehouseId === w.id || a.warehouseId === null) &&
                      a.rateBookId === p.id,
                  ),
                );
                return (
                  <tr
                    className="border-b align-top last:border-0"
                    key={w.id ?? "default"}
                  >
                    <th scope="row" className="p-3 font-medium">
                      {w.name}
                    </th>
                    <td className="p-3">
                      <div>
                        {data.configuredChannelId ? (
                          routingNames.map((p) => p.name).join(", ") ||
                          "No matching program"
                        ) : program ? (
                          <a
                            className="underline"
                            href={`/shipping-settings?tab=pricing-programs&program=${program.id}`}
                          >
                            {program.name}
                          </a>
                        ) : (
                          "Not configured"
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {data.configuredChannelId
                          ? "Managed by routing"
                          : w.id === null
                            ? "Default"
                            : programAssignment
                              ? "Warehouse override"
                              : "Inherited from default"}
                      </div>
                      {!data.configuredChannelId && (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Edit ${w.name} pricing program`}
                          onClick={() => edit("program", w.id)}
                        >
                          Edit
                        </Button>
                      )}
                    </td>
                    <td className="p-3">
                      <div>{suite?.name ?? "Not configured"}</div>
                      <div className="text-xs text-muted-foreground">
                        {w.id === null
                          ? "Default"
                          : suiteAssignment
                            ? "Warehouse override"
                            : "Inherited from default"}
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Edit ${w.name} packaging`}
                        onClick={() => edit("packaging", w.id)}
                      >
                        Edit
                      </Button>
                    </td>
                  </tr>
                );
              })}
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
        <div className="flex flex-wrap gap-4 text-sm">
          <a
            className="underline"
            href="/shipping-settings?tab=pricing-programs"
          >
            Manage pricing programs
          </a>
          <a className="underline" href="/shipping-settings?tab=box-suites">
            Manage box suites
          </a>
        </div>
      </div>
      <section className="space-y-3 rounded border p-4">
        <h3 className="font-medium">Vendor fulfillment service level</h3>
        <div className="flex flex-wrap gap-3">
          <select
            aria-label="Dropship fulfillment service"
            className="h-10 w-full max-w-sm rounded border bg-background px-3"
            value={selectedService}
            disabled={busy}
            onChange={(e) => {
              setService(e.target.value);
              setMessage("");
              setError("");
            }}
          >
            <option value="" disabled>
              Choose service level
            </option>
            {data.serviceLevels.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <Button
            disabled={
              busy ||
              !selectedService ||
              Number(selectedService) === data.selectedService?.id
            }
            onClick={async () => {
              setBusy(true);
              setError("");
              setMessage("");
              const body = {
                channel: "dropship",
                serviceLevelId: Number(selectedService),
                expectedRevision: data.selectedService?.revision ?? 0,
              };
              try {
                await putJson("/api/dropship/admin/shipping/shared/service", {
                  ...body,
                  commandId: commandFor(body),
                });
                invalidateShippingAdmin(client);
                await query.refetch({ throwOnError: true });
                setService(null);
                setMessage("Service level saved.");
              } catch (e) {
                setError(
                  e instanceof Error
                    ? e.message
                    : "Unable to save service level.",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            Save service level
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Quotes require a matching rate for this service level in the assigned
          program. Carrier methods remain configured on the service level.
        </p>
      </section>
      {editing?.part === "packaging" && (
        <PackagingAssignmentEditor
          data={data.packaging}
          channel="dropship"
          dropship
          warehouseId={editing.warehouseId}
          onClose={() => setEditing(null)}
          onSaved={refreshed}
        />
      )}
      {editing?.part === "program" && (
        <DropshipProgramEditor
          data={data}
          warehouseId={editing.warehouseId}
          onClose={() => setEditing(null)}
          onSaved={refreshed}
        />
      )}
    </section>
  );
}
