/**
 * Small pieces the Program finance page repeats: the ⓘ button, the amber
 * check dot, the clock chip, status icons and the colour tokens (spec §6).
 *
 * Colour rules: one accent (the kept segment), greys for the rest of the
 * bar, status colours always with an icon and a word, red only for "Loss"
 * and a negative kept figure, and no hex in markup — every colour is a theme
 * token or one of the --finance-* tokens in index.css.
 */

import React from "react";
import { AlertTriangle, CheckCircle2, Globe, HelpCircle, Info } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type {
  FinanceBarSegmentKey,
  FinanceCheckDotView,
  FinanceCheckTone,
} from "../dropship-finance-model";

/** The bar and legend swatches: the accent for kept, three greys and the empty track. */
export const FINANCE_SEGMENT_CLASSES: Readonly<Record<FinanceBarSegmentKey, string>> = Object.freeze({
  kept: "bg-[hsl(var(--finance-kept))]",
  cogs: "bg-[hsl(var(--finance-cogs))]",
  labels: "bg-[hsl(var(--finance-labels))]",
  pool: "bg-[hsl(var(--finance-pool))]",
  waiting: "bg-[hsl(var(--finance-track))]",
});

/**
 * Status words and their icons. The -700 shades keep the words at 4.5:1 or
 * more on the card, the page and the amber chip in light mode (5.37, 5.13
 * and 4.87:1); the -400 shades are 9:1 or more on the dark card (spec §12).
 */
export const FINANCE_TONE_TEXT_CLASSES: Readonly<Record<FinanceCheckTone, string>> = Object.freeze({
  fine: "text-emerald-700 dark:text-emerald-400",
  attention: "text-amber-700 dark:text-amber-400",
  unknown: "text-muted-foreground",
  program: "text-muted-foreground",
});

/** Red is kept for the word "Loss" and a negative kept figure (spec §6). */
export const FINANCE_LOSS_TEXT_CLASS = "text-red-700 dark:text-red-400";

/** Shared focus ring for the page's own buttons (spec §12: visible rings). */
export const FINANCE_FOCUS_CLASS =
  "rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/** A plain-text link-style button. */
export const FINANCE_TEXT_BUTTON_CLASS = cn(
  "inline-flex min-h-6 items-center text-left text-foreground underline-offset-4 hover:underline",
  FINANCE_FOCUS_CLASS,
);

export function FinanceToneIcon({ tone, className }: { tone: FinanceCheckTone; className?: string }) {
  const iconClass = cn("h-4 w-4 shrink-0", FINANCE_TONE_TEXT_CLASSES[tone], className);
  switch (tone) {
    case "fine":
      return <CheckCircle2 aria-hidden="true" className={iconClass} />;
    case "attention":
      return <AlertTriangle aria-hidden="true" className={iconClass} />;
    case "unknown":
      return <HelpCircle aria-hidden="true" className={iconClass} />;
    case "program":
      return <Globe aria-hidden="true" className={iconClass} />;
  }
}

/**
 * An ⓘ button: its text opens on click, tap or keyboard (a Popover, not a
 * hover-only title), so touch and screen-reader users get it too (spec §12).
 */
export function FinanceInfoButton({ label, text }: { label: string; text: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-finance-action="info"
          aria-label={label}
          className={cn("inline-flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground", FINANCE_FOCUS_CLASS)}
        >
          <Info aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 text-[13px] leading-5 motion-reduce:animate-none" align="start">
        {text}
      </PopoverContent>
    </Popover>
  );
}

/**
 * The amber dot beside a figure whose own check needs a look (spec §8). It
 * opens the Checks row, where that check is listed with its result.
 */
export function FinanceCheckDots({ dots, onOpenChecks }: { dots: readonly FinanceCheckDotView[]; onOpenChecks: () => void }) {
  if (dots.length === 0) return null;
  return (
    <>
      {dots.map((dot) => (
        <button
          key={dot.checkId}
          type="button"
          data-finance-action="open-checks"
          aria-label={`${dot.label}. Opens Checks.`}
          onClick={onOpenChecks}
          className={cn("ml-1 inline-flex h-6 w-6 shrink-0 items-center justify-center align-middle", FINANCE_FOCUS_CLASS)}
        >
          <span aria-hidden="true" className="h-2 w-2 rounded-full bg-amber-500 dark:bg-amber-400" />
        </button>
      ))}
    </>
  );
}

/** A clock chip ("day accepted"): an outline badge with explicit border classes (spec §6). */
export function FinanceClockChip({ text }: { text: string }) {
  return (
    <span className="inline-flex items-center rounded-md border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground">
      {text}
    </span>
  );
}
