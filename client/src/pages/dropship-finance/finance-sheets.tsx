/**
 * The two side sheets of part 1 (spec §3.1, §3.6):
 * - "How this is worked out": the server's working steps for one figure,
 *   rendered as sent and never recomputed, then a collapsed technical source.
 * - "How this page counts": every number's plain definition and its technical
 *   source, the money path, the counting choices and the basis notes, all
 *   from the one definitions registry.
 *
 * Each body is its own component so it can be rendered and tested without
 * the dialog portal around it.
 *
 * Neither sheet has a SheetTrigger (the page opens them from its own
 * buttons), so Radix would send focus to <body> on close. Each sheet takes the
 * element that opened it and gives focus back to it on Esc, ✕ or browser Back
 * (spec §12).
 */

import React from "react";
import { ArrowRight } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { FinanceTechnicalSource } from "@shared/dropship/program-finance-definitions";
import {
  FINANCE_HOW_COUNTS_LINK_TEXT,
  FINANCE_HOW_LINK_TEXT,
  type FinanceCountingEntryView,
  type FinanceCountingView,
  type FinanceHowView,
} from "../dropship-finance-model";
import { FinanceClockChip } from "./finance-ui";

const SHEET_CLASS = "w-full overflow-y-auto p-6 sm:max-w-2xl motion-reduce:animate-none motion-reduce:transition-none";

/** Reads, at close time, the element that opened a sheet; null for a sheet a deep link opened. */
export type FinanceSheetOpener = () => HTMLElement | null;

/**
 * The sheet's onCloseAutoFocus: focus goes back to the opener. With no opener
 * still on the page, Radix's own handling stays.
 */
function focusOpenerOnClose(opener: FinanceSheetOpener) {
  return (event: Event) => {
    const target = opener();
    if (!target || !target.isConnected) return;
    event.preventDefault();
    target.focus();
  };
}

const SUMMARY_CLASS = "min-h-6 cursor-pointer select-none font-medium text-foreground";

/** A technical source as a collapsed list (tables, columns, filters, date column). */
function TechnicalSource({ source }: { source: FinanceTechnicalSource }) {
  return (
    <details className="text-[13px] text-muted-foreground">
      <summary className={SUMMARY_CLASS}>Technical source</summary>
      <dl className="mt-1 space-y-1 pl-3">
        {source.tables.length > 0 ? (
          <div>
            <dt className="font-medium">Tables</dt>
            <dd className="break-words font-mono text-xs">{source.tables.join(", ")}</dd>
          </div>
        ) : null}
        <div>
          <dt className="font-medium">Columns</dt>
          <dd className="break-words font-mono text-xs">{source.columns.join("; ")}</dd>
        </div>
        {source.filters.length > 0 ? (
          <div>
            <dt className="font-medium">Filters</dt>
            <dd className="break-words font-mono text-xs">{source.filters.join("; ")}</dd>
          </div>
        ) : null}
        <div>
          <dt className="font-medium">Date column</dt>
          <dd className="break-words font-mono text-xs">{source.dateColumn ?? "none (a balance right now, or no date)"}</dd>
        </div>
      </dl>
    </details>
  );
}

// ── How this is worked out ───────────────────────────────────────────────

export function FinanceHowBody({ view }: { view: FinanceHowView }) {
  return (
    <div className="space-y-4" data-testid="finance-how-body">
      <div className="space-y-1">
        <p className="text-2xl font-semibold tabular-nums">{view.amount}</p>
        {view.chip ? <FinanceClockChip text={view.chip} /> : null}
        <p className="text-sm text-muted-foreground">{view.definition}</p>
      </div>
      <ol className="space-y-3">
        {view.steps.map((step) => (
          <li key={step.step} className="rounded-md border border-border bg-muted p-3 text-sm">
            <p className="flex gap-2">
              <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-foreground px-1 text-xs font-semibold text-background">
                {step.step}
              </span>
              <span>{step.title}</span>
            </p>
            {step.operands.length > 0 ? (
              <table className="mt-2 w-full text-sm">
                <caption className="sr-only">The figures in step {step.step}</caption>
                <tbody>
                  {step.operands.map((operand, index) => (
                    // Top-aligned, so an operator stays beside the first line of a label that wraps.
                    <tr key={`${operand.label}-${index}`} className="align-top">
                      <td aria-hidden="true" className="w-4 text-center text-xs text-muted-foreground">
                        {operand.operatorSymbol}
                      </td>
                      <th scope="row" className="pl-2 text-left font-normal">
                        {operand.operatorWords ? <span className="sr-only">{operand.operatorWords} </span> : null}
                        {operand.label}
                      </th>
                      <td className="w-20 whitespace-nowrap text-right tabular-nums sm:w-32">{operand.amount}</td>
                    </tr>
                  ))}
                  {step.result !== null ? (
                    <tr className="border-t border-border align-top font-semibold">
                      <td aria-hidden="true" className="w-4 text-center text-xs">=</td>
                      <th scope="row" className="pl-2 text-left font-semibold">
                        <span className="sr-only">equals </span>
                        {step.title}
                      </th>
                      <td className="w-20 whitespace-nowrap text-right tabular-nums sm:w-32">{step.result}</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            ) : step.result !== null ? (
              <p className="mt-1 pl-7 font-semibold tabular-nums">{step.result}</p>
            ) : null}
          </li>
        ))}
      </ol>
      <TechnicalSource source={view.technicalSource} />
    </div>
  );
}

export function FinanceHowSheet({ view, onClose, opener }: { view: FinanceHowView | null; onClose: () => void; opener: FinanceSheetOpener }) {
  return (
    <Sheet open={view !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent side="right" className={SHEET_CLASS} data-testid="finance-how" onCloseAutoFocus={focusOpenerOnClose(opener)}>
        {view ? (
          <>
            <SheetHeader className="space-y-1 pb-4 pr-8">
              <SheetTitle className="text-lg font-semibold">{view.title}</SheetTitle>
              <SheetDescription>{FINANCE_HOW_LINK_TEXT}</SheetDescription>
            </SheetHeader>
            <FinanceHowBody view={view} />
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

// ── How this page counts ─────────────────────────────────────────────────

function CountingEntry({ entry }: { entry: FinanceCountingEntryView }) {
  return (
    <li className="space-y-0.5">
      <p className="text-sm font-medium">{entry.words}</p>
      <p className="text-[13px] text-muted-foreground">{entry.definition}</p>
      {entry.technicalSource ? <TechnicalSource source={entry.technicalSource} /> : null}
    </li>
  );
}

export function FinanceCountingBody({ view }: { view: FinanceCountingView }) {
  return (
    <div className="space-y-6" data-testid="finance-counting-body">
      <p className="text-sm">{view.twoClocks}</p>
      <section aria-labelledby="finance-money-path" className="space-y-2">
        <h3 id="finance-money-path" className="text-sm font-semibold">
          How the money moves
        </h3>
        <ol className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          {view.moneyPath.map((step, index) => (
            <li key={step} className="flex items-center gap-2">
              <span className="rounded-md border border-border bg-muted px-2 py-1 text-[13px]">{step}</span>
              {index < view.moneyPath.length - 1 ? <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
            </li>
          ))}
        </ol>
      </section>
      <section aria-labelledby="finance-choices" className="space-y-2">
        <h3 id="finance-choices" className="text-sm font-semibold">
          Choices this page makes
        </h3>
        <ul className="space-y-2" data-testid="finance-choices-list">
          {view.choices.map((choice) => (
            <li key={choice.key} className="space-y-0.5">
              <p className="text-sm">
                {choice.words}
                {choice.needsSignOff ? (
                  <span className="ml-2 inline-flex rounded-md border border-border px-1.5 text-xs text-muted-foreground">Needs the owner's sign-off</span>
                ) : null}
              </p>
              {/* The owner reads the choice in words; where it sits in the code stays folded away, as for every definition. */}
              <details className="text-[13px] text-muted-foreground">
                <summary className={SUMMARY_CLASS}>Technical source</summary>
                <p className="mt-1 break-words pl-3 font-mono text-xs">{choice.technical}</p>
              </details>
            </li>
          ))}
        </ul>
      </section>
      {view.groups.map((group) => (
        <section key={group.key} aria-labelledby={`finance-counting-${group.key}`} className="space-y-2">
          <h3 id={`finance-counting-${group.key}`} className="text-sm font-semibold">
            {group.title}
          </h3>
          <ul className="space-y-3">
            {group.entries.map((entry) => (
              <CountingEntry key={entry.key} entry={entry} />
            ))}
          </ul>
        </section>
      ))}
      <section aria-labelledby="finance-basis-notes" className="space-y-2">
        <h3 id="finance-basis-notes" className="text-sm font-semibold">
          Basis notes
        </h3>
        <ul className="space-y-3">
          {[...view.basisNotes, ...view.eraNotes].map((entry) => (
            <CountingEntry key={entry.key} entry={entry} />
          ))}
        </ul>
        <p className="text-[13px] text-muted-foreground">{view.vendorScopeNote}</p>
      </section>
    </div>
  );
}

export function FinanceCountingSheet({
  open,
  view,
  onOpenChange,
  opener,
}: {
  open: boolean;
  view: FinanceCountingView;
  onOpenChange: (open: boolean) => void;
  opener: FinanceSheetOpener;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className={SHEET_CLASS} data-testid="finance-counting" onCloseAutoFocus={focusOpenerOnClose(opener)}>
        <SheetHeader className="space-y-1 pb-4 pr-8">
          <SheetTitle className="text-lg font-semibold">{FINANCE_HOW_COUNTS_LINK_TEXT}</SheetTitle>
          <SheetDescription>Every number on this page, what it means and where it comes from.</SheetDescription>
        </SheetHeader>
        {open ? <FinanceCountingBody view={view} /> : null}
      </SheetContent>
    </Sheet>
  );
}
