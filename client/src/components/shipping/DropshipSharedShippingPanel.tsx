import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { dropshipSharedShippingConfigSchema } from "@shared/shipping/configuration";
import {
  getJson,
  putJson,
  invalidateShippingAdmin,
} from "./pricing-programs/api";
import { useConfigurationCommand } from "./configuration-client";
import { ChannelPackagingPanel } from "./ChannelPackagingPanel";
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
  const [editing, setEditing] = useState<{ warehouseId: number | null } | null>(
    null,
  );
  const [service, setService] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
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
  const defaultProgram = data.assignments.find((a) => a.warehouseId === null);
  const renderPricing = (warehouseId: number | null) => {
    const assignment = data.assignments.find(
      (a) => a.warehouseId === warehouseId,
    );
    const program = data.programs.find(
      (p) => p.id === (assignment ?? defaultProgram)?.rateBookId,
    );
    const name =
      warehouseId === null
        ? "Channel default"
        : (data.packaging.warehouses.find((w) => w.id === warehouseId)?.name ??
          String(warehouseId));
    const routingNames = data.programs.filter((p) =>
      data.assignments.some(
        (a) =>
          (a.warehouseId === warehouseId || a.warehouseId === null) &&
          a.rateBookId === p.id,
      ),
    );
    return (
      <div>
        {data.configuredChannelId ? (
          <>
            <div>
              {routingNames.map((p) => p.name).join(", ") ||
                "No matching program"}
            </div>
            <a
              className="text-xs underline"
              href={`/shipping-settings?tab=channel-routing&channelId=${data.configuredChannelId}`}
            >
              Manage pricing routing
            </a>
            <div className="text-xs text-muted-foreground">
              Destination rules determine the applicable rate.
            </div>
          </>
        ) : (
          <>
            {program ? (
              <a
                className="underline"
                href={`/shipping-settings?tab=pricing-programs&program=${program.id}`}
              >
                {program.name}
              </a>
            ) : (
              "Not configured"
            )}
            <div className="text-xs text-muted-foreground">
              {warehouseId === null
                ? "Default"
                : assignment
                  ? "Warehouse override"
                  : "Inherited from default"}
            </div>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Edit ${name} pricing program`}
              onClick={() => {
                setMessage("");
                setEditing({ warehouseId });
              }}
            >
              Edit
            </Button>
          </>
        )}
      </div>
    );
  };
  return (
    <section className="space-y-5 rounded-lg border bg-card p-5">
      <div>
        <h2 className="text-lg font-semibold">Dropship shipping</h2>
        <p className="text-sm text-muted-foreground">
          Shared pricing and packaging with independent warehouse assignments.
        </p>
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
      <ChannelPackagingPanel dropship renderPricing={renderPricing} />
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
          pricing program. Carrier methods remain configured on the service
          level.
        </p>
      </section>
      {editing && (
        <DropshipProgramEditor
          data={data}
          warehouseId={editing.warehouseId}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            await query.refetch({ throwOnError: true });
            setMessage("Pricing program saved.");
          }}
        />
      )}
    </section>
  );
}
