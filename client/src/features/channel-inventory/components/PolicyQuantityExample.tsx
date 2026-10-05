import { useId, useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { formatUnits } from "../format";
import type { PolicyForm } from "../model";
import { buildPolicyQuantityExample } from "../quantity-example";

// A round hypothetical amount makes percentage and buffer effects easy to compare.
const INITIAL_EXAMPLE_STOCK = "100";

export function PolicyQuantityExample({ form }: { form: PolicyForm }) {
  const id = useId();
  const [stock, setStock] = useState(INITIAL_EXAMPLE_STOCK);
  const example = buildPolicyQuantityExample(form, stock);
  const invalidStock = !example.ok && !!example.stockError;
  return (
    <section aria-labelledby={`${id}-title`} className="min-w-0 space-y-4 rounded-lg border border-primary/20 bg-primary/5 p-4">
      <div>
        <h3 id={`${id}-title`} className="text-sm font-semibold">Quantity example</h3>
        <p id={`${id}-help`} className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Try a stock quantity to see how these settings work. This is an example; Review checks actual stock and publishing readiness.
        </p>
      </div>
      <div className="flex min-w-0 flex-wrap items-end gap-x-8 gap-y-4">
        <div className="space-y-2">
          <Label htmlFor={`${id}-stock`}>Example available stock</Label>
          <div className="flex items-center gap-2">
            <Input
              id={`${id}-stock`}
              value={stock}
              onChange={(event) => setStock(event.target.value)}
              inputMode="numeric"
              autoComplete="off"
              className="w-28 tabular-nums"
              aria-describedby={`${id}-help${invalidStock ? ` ${id}-message` : ""}`}
              aria-invalid={invalidStock || undefined}
            />
            <span className="text-xs text-muted-foreground">sellable units</span>
          </div>
        </div>
        <div className="min-w-0" aria-live="polite" aria-atomic="true">
          {example.ok ? (
            <p className="break-words text-xl font-semibold tabular-nums text-primary">
              {formatUnits(example.publishedUnits)} {example.publishedUnits === "1" ? "unit" : "units"} shown
            </p>
          ) : (
            <p id={`${id}-message`} className="text-sm text-muted-foreground">{example.message}</p>
          )}
        </div>
      </div>
      {example.ok && example.steps.length > 1 && (
        <dl className="grid grid-cols-1 gap-3 border-t border-primary/15 pt-3 sm:grid-cols-2 lg:grid-cols-4">
          {example.steps.map((step) => (
            <div key={step.label} className="min-w-0">
              <dt className="text-xs leading-relaxed text-muted-foreground">{step.label}</dt>
              <dd className="mt-1 break-words text-sm font-medium tabular-nums">
                {formatUnits(step.units)} {step.units === "1" ? "unit" : "units"}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
