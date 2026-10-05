/**
 * The sticky period bar and the two-clocks line under it (spec §3.1, §5).
 *
 * No money numbers sit here. The bar renders before the summary arrives: the
 * preset, the custom dates when the URL has them, "Checking…" for the chip.
 * On a phone, Compare and "How this page counts" fold into the ⋯ menu.
 */

import React, { useState } from "react";
import type { DateRange } from "react-day-picker";
import { MoreHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { FinancePeriodPreset } from "@shared/dropship/program-finance";
import {
  FINANCE_CHECKING_TEXT,
  FINANCE_HOW_COUNTS_LINK_TEXT,
  FINANCE_PAGE_TITLE,
  FINANCE_PERIOD_PRESET_LABELS,
  FINANCE_PERIOD_PRESET_OPTIONS,
  FINANCE_TWO_CLOCKS_TEXT,
  financeCalendarDateToLocalDate,
  financeLocalDateToCalendarDate,
  financePeriodPresetFromSelect,
  validateFinanceCustomRange,
  type FinancePeriodBarView,
  type FinanceUrlState,
} from "../dropship-finance-model";
import { FINANCE_FOCUS_CLASS, FINANCE_TEXT_BUTTON_CLASS, FINANCE_TONE_TEXT_CLASSES, FinanceToneIcon } from "./finance-ui";

/** The sticky bar's id: the panel measures it to keep a row it scrolls to clear of the bar. */
export const FINANCE_PERIOD_BAR_ID = "finance-period-bar";
const COMPARE_SWITCH_ID = "finance-compare";
const COMPARE_HINT_ID = "finance-compare-hint";
const CUSTOM_ERROR_ID = "finance-custom-range-error";

export interface FinancePeriodBarProps {
  readonly view: FinancePeriodBarView;
  readonly state: FinanceUrlState;
  /** Today's Eastern day (YYYY-MM-DD): the picker greys out later days. */
  readonly todayEastern: string;
  readonly onPreset: (preset: Exclude<FinancePeriodPreset, "custom">) => void;
  readonly onCustomRange: (from: string, to: string) => void;
  readonly onCompare: (compare: boolean) => void;
  readonly onRemoveVendor: () => void;
  readonly onOpenChecks: () => void;
  readonly onOpenCounting: () => void;
}

export function FinancePeriodBar(props: FinancePeriodBarProps) {
  const { view, state } = props;
  const [customOpen, setCustomOpen] = useState(false);
  const compareChecked = state.compare && !view.compareDisabled;

  return (
    <section
      id={FINANCE_PERIOD_BAR_ID}
      aria-label="Period"
      data-testid="finance-period-bar"
      className="sticky top-0 z-10 -mx-4 border-b bg-background/95 px-4 py-3 backdrop-blur md:-mx-6 md:px-6"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="text-base font-semibold">{FINANCE_PAGE_TITLE}</h2>
        <Select
          value={state.period}
          onValueChange={(value) => {
            const preset = financePeriodPresetFromSelect(value);
            if (preset === "custom") setCustomOpen(true);
            else if (preset !== null) props.onPreset(preset);
          }}
        >
          <SelectTrigger className="h-9 w-auto min-w-[11rem]" aria-label="Period">
            <SelectValue>{view.presetLabel}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {FINANCE_PERIOD_PRESET_OPTIONS.map((preset) => (
              <SelectItem key={preset} value={preset}>
                {FINANCE_PERIOD_PRESET_LABELS[preset]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <CustomRangePicker
          open={customOpen}
          onOpenChange={setCustomOpen}
          dateText={view.dateText}
          state={state}
          todayEastern={props.todayEastern}
          onApply={(from, to) => {
            setCustomOpen(false);
            props.onCustomRange(from, to);
          }}
        />
        <div className="hidden items-center gap-2 sm:flex">
          <Switch
            id={COMPARE_SWITCH_ID}
            checked={compareChecked}
            disabled={view.compareDisabled}
            onCheckedChange={(checked) => props.onCompare(checked)}
            aria-describedby={view.compareHint ? COMPARE_HINT_ID : undefined}
          />
          <Label htmlFor={COMPARE_SWITCH_ID} className="text-sm font-normal">
            {view.compareLabel}
          </Label>
          {view.compareHint ? (
            <span id={COMPARE_HINT_ID} className="text-xs text-muted-foreground">
              {view.compareHint}
            </span>
          ) : null}
        </div>
        {view.vendorChip ? (
          <span className="inline-flex items-center gap-1 rounded-md border border-border bg-card py-0.5 pl-2 pr-0.5 text-sm">
            {view.vendorChip.label}
            <button
              type="button"
              data-finance-action="remove-vendor"
              aria-label={`Remove ${view.vendorChip.label}: show all vendors`}
              onClick={props.onRemoveVendor}
              className={cn("inline-flex h-7 w-7 items-center justify-center text-muted-foreground hover:text-foreground", FINANCE_FOCUS_CLASS)}
            >
              <X aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
          </span>
        ) : null}
        <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
          {view.checksChip ? (
            <button
              type="button"
              data-finance-action="open-checks"
              onClick={props.onOpenChecks}
              className={cn(
                "inline-flex min-h-8 items-center gap-1.5 rounded-md border border-border px-2 text-xs font-medium",
                view.checksChip.tone === "attention" && "bg-amber-50 dark:bg-amber-950/40",
                FINANCE_TONE_TEXT_CLASSES[view.checksChip.tone],
                FINANCE_FOCUS_CLASS,
              )}
            >
              <FinanceToneIcon tone={view.checksChip.tone} className="h-3.5 w-3.5" />
              {view.checksChip.text}
            </button>
          ) : (
            <span className="text-xs text-muted-foreground">{FINANCE_CHECKING_TEXT}</span>
          )}
          {view.asOf ? (
            <span className="text-xs text-muted-foreground" data-testid="finance-as-of">
              {view.asOf}
            </span>
          ) : (
            <Skeleton className="h-4 w-36" />
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="sm:hidden" aria-label="More period options">
                <MoreHorizontal aria-hidden="true" className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuCheckboxItem
                checked={compareChecked}
                disabled={view.compareDisabled}
                onCheckedChange={(checked) => props.onCompare(checked === true)}
              >
                {view.compareDisabled ? view.compareHint : view.compareLabel}
              </DropdownMenuCheckboxItem>
              <DropdownMenuItem onSelect={props.onOpenCounting}>{FINANCE_HOW_COUNTS_LINK_TEXT}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </section>
  );
}

/** The exact dates, which also open the custom range picker (spec §5 "Custom"). */
function CustomRangePicker(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dateText: string | null;
  state: FinanceUrlState;
  todayEastern: string;
  onApply: (from: string, to: string) => void;
}) {
  const [range, setRange] = useState<DateRange | undefined>(() => ({
    from: financeLocalDateToCalendarDate(props.state.from),
    to: financeLocalDateToCalendarDate(props.state.to),
  }));
  const [error, setError] = useState<string | null>(null);
  const today = financeLocalDateToCalendarDate(props.todayEastern);

  function apply() {
    const from = range?.from ? financeCalendarDateToLocalDate(range.from) : null;
    const to = range?.to ? financeCalendarDateToLocalDate(range.to) : null;
    const problem = validateFinanceCustomRange(from, to, props.todayEastern);
    setError(problem);
    // An invalid range never becomes a request (spec §5).
    if (problem === null && from !== null && to !== null) props.onApply(from, to);
  }

  return (
    <Popover open={props.open} onOpenChange={props.onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-finance-action="pick-dates"
          aria-label={props.dateText ? `Pick custom dates. Showing ${props.dateText}` : "Pick custom dates"}
          className={cn("inline-flex min-h-9 items-center px-1 text-sm tabular-nums text-foreground hover:underline", FINANCE_FOCUS_CLASS)}
        >
          {props.dateText ?? <Skeleton className="h-4 w-28" />}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-3 motion-reduce:animate-none" align="start">
        <Calendar
          mode="range"
          numberOfMonths={2}
          selected={range}
          onSelect={(next) => {
            setRange(next);
            setError(null);
          }}
          disabled={today ? { after: today } : undefined}
          defaultMonth={range?.from ?? today}
        />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <p id={CUSTOM_ERROR_ID} role={error ? "alert" : undefined} className="text-[13px] text-muted-foreground">
            {error ?? "Pick the first and the last day."}
          </p>
          <Button size="sm" data-finance-action="apply-dates" onClick={apply} aria-describedby={CUSTOM_ERROR_ID}>
            Apply
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The sentence under the bar and the link to "How this page counts", plus any policy-era notes (spec §3.1, §7). */
export function FinanceTwoClocksLine({ notes, onOpenCounting }: { notes: readonly string[]; onOpenCounting: () => void }) {
  return (
    <div className="space-y-1">
      <p className="text-[13px] text-muted-foreground">
        {FINANCE_TWO_CLOCKS_TEXT}{" "}
        <button type="button" data-finance-action="open-counting" onClick={onOpenCounting} className={FINANCE_TEXT_BUTTON_CLASS}>
          {FINANCE_HOW_COUNTS_LINK_TEXT} ›
        </button>
      </p>
      {notes.length > 0 ? (
        <ul className="space-y-0.5 text-[13px] text-muted-foreground" data-testid="finance-notes">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
