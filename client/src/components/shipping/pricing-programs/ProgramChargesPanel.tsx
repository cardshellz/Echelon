import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  NO_PROGRAM_CHARGES,
  programChargesSchema,
  type ProgramCharges,
} from "@shared/shipping/configuration";
import { getJson, putJson } from "./api";
import { useConfigurationCommand } from "../BoxSuitesPanel";
import { ConfigurationHistory } from "../ConfigurationHistory";

function decimalUnits(text: string, nullable = false): number | null {
  if (!text.trim() && nullable) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(text))
    throw new Error(
      "Use a non-negative amount with at most two decimal places.",
    );
  const [whole, fractional = ""] = text.split(".");
  const value = BigInt(whole) * BigInt(100) + BigInt(fractional.padEnd(2, "0"));
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Amount is too large.");
  return Number(value);
}
function decimalText(value: number | null): string {
  return value === null
    ? ""
    : `${Math.trunc(value / 100)}.${String(value % 100).padStart(2, "0")}`;
}
type Fields = Record<
  keyof ProgramCharges,
  { bps: string; fixedCents: string; minCents: string; maxCents: string }
>;
function toFields(charges: ProgramCharges): Fields {
  return Object.fromEntries(
    Object.entries(charges).map(([key, fee]) => [
      key,
      Object.fromEntries(
        Object.entries(fee).map(([name, value]) => [name, decimalText(value)]),
      ),
    ]),
  ) as Fields;
}
export function ProgramChargesPanel({
  bookId,
  disabled = false,
}: {
  bookId: number;
  disabled?: boolean;
}) {
  const url = `/api/shipping/admin/rate-books/${bookId}/charges`;
  const query = useQuery({
    queryKey: [url],
    queryFn: () => getJson<{ revision: number; charges: ProgramCharges }>(url),
  });
  const [fields, setFields] = useState<Fields | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const commandFor = useConfigurationCommand();
  const charges = query.data?.charges ?? NO_PROGRAM_CHARGES;
  return (
    <section className="rounded-lg border p-4 space-y-3">
      <div className="flex justify-between gap-3">
        <div>
          <h3 className="font-semibold">Markup and insurance charge</h3>
          <p className="text-sm text-muted-foreground">
            Owned by this pricing program and applied once after its rate rules.
            These are charges, not carrier insurance coverage.
          </p>
        </div>
        {!fields && (
          <Button
            variant="outline"
            disabled={disabled || !query.data}
            onClick={() => {
              setFields(toFields(charges));
              setRevision(query.data!.revision);
              setError("");
            }}
          >
            Edit
          </Button>
        )}
      </div>
      {query.isError && (
        <p role="alert">
          Unable to load charge rules.{" "}
          <Button variant="outline" onClick={() => query.refetch()}>
            Retry
          </Button>
        </p>
      )}
      {!fields && query.data && (
        <p className="text-sm">
          Markup: {decimalText(charges.markup.bps)}% + $
          {decimalText(charges.markup.fixedCents)} · Insurance:{" "}
          {decimalText(charges.insurance.bps)}% + $
          {decimalText(charges.insurance.fixedCents)} · Revision{" "}
          {query.data.revision}
        </p>
      )}
      <ConfigurationHistory resourceKey={`program-charges:${bookId}`} />
      {fields && (
        <form
          className="space-y-3"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            try {
              const next = programChargesSchema.parse(
                Object.fromEntries(
                  Object.entries(fields).map(([key, fee]) => [
                    key,
                    {
                      bps: decimalUnits(fee.bps),
                      fixedCents: decimalUnits(fee.fixedCents),
                      minCents: decimalUnits(fee.minCents, true),
                      maxCents: decimalUnits(fee.maxCents, true),
                    },
                  ]),
                ),
              );
              const body = { expectedRevision: revision, charges: next };
              await putJson(url, { ...body, commandId: commandFor(body) });
              await query.refetch({ throwOnError: true });
              setFields(null);
            } catch (e) {
              setError(
                e instanceof Error ? e.message : "Unable to save charge rules.",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          {(["markup", "insurance"] as const).map((kind) => (
            <fieldset key={kind} className="grid gap-3 sm:grid-cols-4">
              <legend className="text-sm font-medium mb-2 capitalize">
                {kind}
              </legend>
              {(
                [
                  ["bps", "Percent"],
                  ["fixedCents", "Flat charge ($)"],
                  ["minCents", "Minimum ($, optional)"],
                  ["maxCents", "Maximum ($, optional)"],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="grid gap-1 text-sm">
                  {label}
                  <Input
                    inputMode="decimal"
                    value={fields[kind][key]}
                    onChange={(e) =>
                      setFields({
                        ...fields,
                        [kind]: { ...fields[kind], [key]: e.target.value },
                      })
                    }
                  />
                </label>
              ))}
            </fieldset>
          ))}
          <p className="text-xs text-muted-foreground">
            Markup is based on the program rate. Insurance is based on rate +
            markup. Percentages round down to whole cents before flat charges
            and caps. Saving changes future quotes for every assignment using
            this program; saved orders keep their original charge.
          </p>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button disabled={busy}>Save charge rules</Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setFields(null)}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
