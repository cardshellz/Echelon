import { Link } from "wouter";
import { CheckCircle2, Circle, CircleDashed } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatStatus } from "@/lib/dropship-ops-surface";
import {
  CATALOG_STEPS,
  CATALOG_STEP_LABELS,
  CATALOG_STEP_SHORT_LABELS,
  type CatalogStep,
  type CatalogStepTick,
  type CatalogStoreOption,
} from "@/lib/dropship-catalog-steps";

export interface CatalogStepRailProps {
  current: CatalogStep;
  hrefFor: (step: CatalogStep) => string;
  /** Null when a step has no tick yet (Publish, until publish runs exist: design PR 7). */
  ticks: Readonly<Record<CatalogStep, CatalogStepTick | null>>;
  /** One short line under a step, such as "3 selected". */
  details: Readonly<Partial<Record<CatalogStep, string>>>;
  storeOptions: readonly CatalogStoreOption[];
  selectedStoreConnectionId: number | null;
  onStoreChange: (storeConnectionId: number) => void;
}

/** Read by screen readers after the step's name; the icon alone carries it visually. */
const TICK_TEXT: Readonly<Record<CatalogStepTick, string>> = {
  done: "done",
  todo: "not done yet",
  unknown: "checking",
};

/** The three steps, each ticked from saved server state, and the one store the page works on. */
export function CatalogStepRail({
  current,
  details,
  hrefFor,
  onStoreChange,
  selectedStoreConnectionId,
  storeOptions,
  ticks,
}: CatalogStepRailProps) {
  return (
    <div
      className="sticky top-0 z-20 -mx-4 mt-4 border-b border-zinc-200 bg-white/95 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6 sm:py-3"
      data-testid="catalog-step-rail"
    >
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <nav aria-label="Catalog steps">
          <ol className="grid grid-cols-3 gap-1 sm:flex sm:items-stretch">
            {CATALOG_STEPS.map((step, index) => {
              const isCurrent = step === current;
              const tick = ticks[step];
              const detail = details[step];
              return (
                <li key={step}>
                  <Link
                    href={hrefFor(step)}
                    aria-current={isCurrent ? "step" : undefined}
                    data-testid={`catalog-step-${step}`}
                    className={isCurrent
                      ? "flex h-full items-start gap-1.5 rounded-md bg-[#C060E0]/10 px-2 py-2 text-sm text-[#8c35aa] sm:gap-2 sm:px-3"
                      : "flex h-full items-start gap-1.5 rounded-md px-2 py-2 text-sm text-zinc-700 hover:bg-zinc-100 sm:gap-2 sm:px-3"}
                  >
                    <StepMarker tick={tick} />
                    <span>
                      {/* One label is display:none at any width, so the link's name is the visible one. */}
                      <span className="font-medium sm:hidden">{index + 1} · {CATALOG_STEP_SHORT_LABELS[step]}</span>
                      <span className="hidden font-medium sm:inline">{index + 1} · {CATALOG_STEP_LABELS[step]}</span>
                      {tick && <span className="sr-only">, {TICK_TEXT[tick]}</span>}
                      {detail && <span className="block text-xs text-zinc-500">{detail}</span>}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ol>
        </nav>
        <CatalogStoreSelect
          options={storeOptions}
          selectedStoreConnectionId={selectedStoreConnectionId}
          onStoreChange={onStoreChange}
        />
      </div>
    </div>
  );
}

function StepMarker({ tick }: { tick: CatalogStepTick | null }) {
  if (tick === "done") return <CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />;
  if (tick === "unknown") return <CircleDashed aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-zinc-300" />;
  return <Circle aria-hidden="true" className={tick === "todo" ? "mt-0.5 h-4 w-4 shrink-0 text-zinc-400" : "mt-0.5 h-4 w-4 shrink-0 text-zinc-300"} />;
}

function CatalogStoreSelect({
  onStoreChange,
  options,
  selectedStoreConnectionId,
}: {
  options: readonly CatalogStoreOption[];
  selectedStoreConnectionId: number | null;
  onStoreChange: (storeConnectionId: number) => void;
}) {
  const unsupported = options.filter((option) => !option.selectable);
  if (!options.some((option) => option.selectable)) {
    return (
      <p className="text-sm text-zinc-600" data-testid="catalog-store-none">
        <span className="font-medium text-zinc-900">No eBay store ready.</span>
        {unsupported.length > 0 && ` ${unsupported.map(describeUnsupported).join(", ")}: not supported yet.`}
      </p>
    );
  }
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-zinc-600" id="catalog-store-label">Store</span>
      <Select
        value={selectedStoreConnectionId === null ? "" : String(selectedStoreConnectionId)}
        onValueChange={(value) => onStoreChange(Number(value))}
      >
        <SelectTrigger className="h-9 w-full sm:w-72" aria-labelledby="catalog-store-label" data-testid="catalog-store-select">
          <SelectValue placeholder="Choose an eBay store" />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.storeConnectionId} value={String(option.storeConnectionId)} disabled={!option.selectable}>
              {option.selectable ? `${option.name} (eBay)` : `${describeUnsupported(option)} · Not supported yet`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function describeUnsupported(option: CatalogStoreOption): string {
  return `${option.name} (${formatStatus(option.platform)})`;
}
