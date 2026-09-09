import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { getJson, putJson } from "./pricing-programs/api";
import { useConfigurationCommand } from "./BoxSuitesPanel";
import { dropshipSharedShippingConfigSchema } from "@shared/shipping/configuration";

const selectClass = "h-10 w-full rounded-md border bg-background px-3 text-sm";
export function DropshipSharedShippingPanel() {
  const query = useQuery({
    queryKey: ["/api/dropship/admin/shipping/shared"],
    queryFn: async () =>
      dropshipSharedShippingConfigSchema.parse(
        await getJson("/api/dropship/admin/shipping/shared"),
      ),
  });
  const [warehouse, setWarehouse] = useState("");
  const [program, setProgram] = useState("");
  const [suite, setSuite] = useState("");
  const [service, setService] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const commandFor = useConfigurationCommand();
  const data = query.data;
  const warehouseId = warehouse ? Number(warehouse) : null;
  const assignment = data?.assignments.find(
    (a) => a.warehouseId === warehouseId,
  );
  const inheritedProgram =
    assignment ?? data?.assignments.find((a) => a.warehouseId === null);
  const packaging =
    data?.packaging.assignments.filter((a) => a.channel === "dropship") ?? [];
  const boxAssignment = packaging.find((a) => a.warehouseId === warehouseId);
  const inheritedSuite =
    boxAssignment ?? packaging.find((a) => a.warehouseId === null);
  async function save(part: string, body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await putJson(`/api/dropship/admin/shipping/shared/${part}`, {
        ...body,
        commandId: commandFor({ part, ...body }),
      });
      await query.refetch({ throwOnError: true });
      setProgram("");
      setSuite("");
      setService("");
      setMessage("Saved. New quotes use the updated shared configuration.");
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Unable to save shipping configuration.",
      );
    } finally {
      setBusy(false);
    }
  }
  if (!data)
    return (
      <div role={query.isError ? "alert" : undefined}>
        {query.isLoading
          ? "Loading shared shipping configuration…"
          : "Unable to load shipping configuration."}
        <Button variant="outline" onClick={() => query.refetch()}>
          Refresh
        </Button>
      </div>
    );
  return (
    <section className="space-y-5 rounded-lg border bg-card p-5">
      <div className="flex flex-wrap justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Dropship shipping</h2>
          <p className="text-sm text-muted-foreground">
            Shared packing and pricing, with assignments specific to Dropship.
            Vendor store connections do not maintain separate rate cards.
          </p>
        </div>
        <Button variant="outline" onClick={() => query.refetch()}>
          Refresh
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm text-emerald-700">
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
            `Deployment shipping mode is ${data.runtimeMode}. Shared pricing applies only to enabled stores; the remaining stores still use preserved legacy rates. Switch the deployment to live before retiring rollback configuration.`}
        </p>
      )}
      <label className="grid max-w-sm gap-1 text-sm">
        Configuration scope
        <select
          className={selectClass}
          value={warehouse}
          onChange={(e) => {
            setWarehouse(e.target.value);
            setProgram("");
            setSuite("");
          }}
        >
          <option value="">Channel default</option>
          {data.packaging.warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </label>
      <div className="grid gap-5 md:grid-cols-2">
        <section className="space-y-3 rounded border p-4">
          <h3 className="font-medium">Pricing program</h3>
          <p className="text-sm">
            {data.configuredChannelId ? (
              data.programs
                .filter((p) =>
                  data.assignments.some((a) => a.rateBookId === p.id),
                )
                .map((p) => p.name)
                .join(", ") || "No active pricing program in routing"
            ) : (
              <>
                {data.programs.find(
                  (p) => p.id === inheritedProgram?.rateBookId,
                )?.name ?? "Not configured"}
                {!assignment && inheritedProgram ? " · inherited" : ""}
              </>
            )}
          </p>
          {data.configuredChannelId ? (
            <p className="text-sm text-muted-foreground">
              Channel routing owns this selection, including warehouse and
              destination overrides. Edit it there to publish a validated
              routing revision.
            </p>
          ) : (
            <>
              <select
                aria-label="Dropship pricing program"
                className={selectClass}
                value={program}
                onChange={(e) => setProgram(e.target.value)}
              >
                <option value="">Choose pricing program</option>
                {data.programs.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <Button
                disabled={
                  busy || !program || assignment?.rateBookId === Number(program)
                }
                onClick={() =>
                  save("program", {
                    warehouseId,
                    rateBookId: Number(program),
                    expectedProgramId: assignment?.rateBookId ?? null,
                  })
                }
              >
                Save program
              </Button>
            </>
          )}
          <p className="text-xs text-muted-foreground">
            Rates, destination coverage, markup and insurance charges are
            maintained in the program.
          </p>
          <a
            className="block text-sm underline"
            href={`/shipping-settings?tab=${data.configuredChannelId ? "channel-routing" : "pricing-programs"}`}
          >
            Edit shared pricing configuration
          </a>
        </section>
        <section className="space-y-3 rounded border p-4">
          <h3 className="font-medium">Packaging suite</h3>
          <p className="text-sm">
            {data.packaging.suites.find((s) => s.id === inheritedSuite?.suiteId)
              ?.name ?? "Not configured"}
            {!boxAssignment && inheritedSuite ? " · inherited" : ""}
          </p>
          <select
            aria-label="Dropship packaging suite"
            className={selectClass}
            value={suite}
            onChange={(e) => setSuite(e.target.value)}
          >
            <option value="">Choose suite</option>
            {data.packaging.suites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <Button
            disabled={
              busy || !suite || boxAssignment?.suiteId === Number(suite)
            }
            onClick={() =>
              save("packaging", {
                channel: "dropship",
                warehouseId,
                suiteId: Number(suite),
                expectedRevision: boxAssignment?.revision ?? 0,
              })
            }
          >
            Save suite assignment
          </Button>
          <p className="text-xs text-muted-foreground">
            Only suite members available at the fulfillment warehouse can be
            used. This selection is independent of pricing.
          </p>
          <a
            className="block text-sm underline"
            href="/shipping-settings?tab=boxes"
          >
            Edit shared boxes and suites
          </a>
        </section>
      </div>
      <section className="space-y-3 rounded border p-4">
        <h3 className="font-medium">Vendor fulfillment service level</h3>
        <p className="text-sm">
          {data.serviceLevels.find((s) => s.id === data.selectedService?.id)
            ?.name ?? "Not configured"}
        </p>
        <div className="flex flex-wrap gap-3">
          <select
            aria-label="Dropship fulfillment service"
            className={`${selectClass} max-w-sm`}
            value={service}
            onChange={(e) => setService(e.target.value)}
          >
            <option value="">Choose service level</option>
            {data.serviceLevels.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <Button
            disabled={
              busy || !service || Number(service) === data.selectedService?.id
            }
            onClick={() =>
              save("service", {
                channel: "dropship",
                serviceLevelId: Number(service),
                expectedRevision: data.selectedService?.revision ?? 0,
              })
            }
          >
            Save service level
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Quotes require a matching rate for this service level in the assigned
          program. Carrier methods remain configured on the service level.
        </p>
      </section>
      <p className="text-sm text-muted-foreground">
        Test the complete vendor charge in a listing preview using its quantity
        and destination. Shared pricing programs also provide “Test live rates”
        for rate coverage checks.
      </p>
    </section>
  );
}
