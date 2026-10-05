/**
 * The answer card and the four tiles (spec §3.2, §3.3, §7).
 *
 * The card answers one question first, "did the program make money?", with
 * "What we kept" and the words "before packaging, Stripe fees and overheads"
 * attached to it. Beside it, one bar shows where each $1 we billed went; the
 * legend under it is a real table with every exact amount, so the bar's
 * greys never have to carry a number on their own.
 */

import React, { type CSSProperties } from "react";
import { ArrowDownRight, ArrowUpRight, Clock, TrendingDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  FINANCE_INFO_TEXT,
  FINANCE_LOSS_WORD,
  type FinanceAnswerView,
  type FinanceBarView,
  type FinanceHeroSize,
  type FinanceTileView,
} from "../dropship-finance-model";
import {
  FINANCE_FOCUS_CLASS,
  FINANCE_LOSS_TEXT_CLASS,
  FINANCE_SEGMENT_CLASSES,
  FinanceCheckDots,
  FinanceInfoButton,
} from "./finance-ui";

/** Never compact money: the hero steps its font down instead (spec §6), and is 32px under 640px. */
const HERO_SIZE_CLASSES: Readonly<Record<FinanceHeroSize, string>> = Object.freeze({
  xl: "text-[32px] leading-[40px] sm:text-[40px] sm:leading-[48px]",
  lg: "text-[32px] leading-[40px]",
  md: "text-[28px] leading-[36px]",
});

/** A segment's share of the bar as a flex weight: layout only, no float maths in the browser. */
function weightStyle(weight: number, minimumPx: number): CSSProperties {
  return { flexGrow: weight, flexShrink: 1, flexBasis: 0, minWidth: weight > 0 ? minimumPx : 0 };
}

/** The 2px sliver: a tiny non-zero part stays visible (spec §6). */
const MIN_SLIVER_PX = 2;

/**
 * The widest character a tile value can hold, in em: DejaVu Sans Bold, the
 * widest fallback font met so far, has 0.70em digits (Roboto and SF are
 * narrower). Sizing for it keeps every value on one line in any font.
 */
const TILE_VALUE_EM_PER_CHARACTER = 0.7;

/**
 * A tile value never wraps, truncates or compacts (spec §6: the font steps
 * down instead). Two tiles share a phone's width, so the font follows the
 * tile's own width (a container query on the tile) and the value's length:
 * at most the spec's 24px, and never wider than the tile, so "$1,234,567.89"
 * stays on one line in a 360px phone's tile. Layout only; no figure changes.
 */
function tileValueStyle(text: string): CSSProperties {
  return { fontSize: `min(1.5rem, calc(100cqi / ${Math.max(text.length, 1)} / ${TILE_VALUE_EM_PER_CHARACTER}))` };
}

export interface FinanceAnswerCardProps {
  readonly view: FinanceAnswerView;
  /** `opener` is the hero button, so the drawer can give focus back to it. */
  readonly onOpenHow: (opener: HTMLElement | null) => void;
  readonly onOpenChecks: () => void;
  readonly onRetry: () => void;
}

export function FinanceAnswerCard({ view, onOpenHow, onOpenChecks, onRetry }: FinanceAnswerCardProps) {
  return (
    <section aria-labelledby="finance-answer-title" data-testid="finance-answer" className="rounded-md border bg-card p-5">
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="min-w-0 space-y-4">
          <AnswerHero view={view} onOpenHow={onOpenHow} onOpenChecks={onOpenChecks} onRetry={onRetry} />
          {view.errorText === null || view.hero !== null ? <AnswerCoverage view={view} /> : null}
          {view.pointsLine ? (
            <p className="flex items-start gap-1 text-[13px] text-muted-foreground">
              <span>{view.pointsLine}</span>
              <FinanceInfoButton label="About points" text={FINANCE_INFO_TEXT.points} />
            </p>
          ) : null}
        </div>
        <FinanceBar bar={view.bar} bridge={view.bridge} />
      </div>
    </section>
  );
}

function AnswerHero({ view, onOpenHow, onOpenChecks, onRetry }: FinanceAnswerCardProps) {
  const title = (
    <div className="flex items-center gap-1">
      <h2 id="finance-answer-title" className="text-sm font-medium">
        {view.title}
      </h2>
      <FinanceInfoButton label={`About ${view.title.toLowerCase()}`} text={FINANCE_INFO_TEXT.kept} />
      <FinanceCheckDots dots={view.checkDots} onOpenChecks={onOpenChecks} />
    </div>
  );

  if (view.hero === null) {
    return (
      <div className="space-y-1">
        {title}
        {view.errorText ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">{view.errorText}</p>
            <Button size="sm" variant="outline" data-finance-action="retry" onClick={onRetry}>
              Try again
            </Button>
          </div>
        ) : (
          <>
            <p className="text-2xl font-semibold" data-testid="finance-answer-headline">
              {view.headline}
            </p>
            {view.headlineDetail ? <p className="text-[13px] text-muted-foreground">{view.headlineDetail}</p> : null}
          </>
        )}
      </div>
    );
  }

  const value = (
    <span className={cn("inline-flex items-center gap-2 font-semibold", HERO_SIZE_CLASSES[view.hero.size], view.hero.loss && FINANCE_LOSS_TEXT_CLASS)}>
      {view.hero.loss ? <TrendingDown aria-hidden="true" className="h-6 w-6 shrink-0" /> : null}
      {view.hero.text}
    </span>
  );
  return (
    <div className="space-y-1">
      {title}
      {view.hero.loss ? <p className={cn("text-sm font-semibold", FINANCE_LOSS_TEXT_CLASS)}>{FINANCE_LOSS_WORD}</p> : null}
      {view.hasWorkings ? (
        <button
          type="button"
          data-finance-action="open-how"
          aria-label={`${view.hero.spoken}, opens how it was worked out`}
          onClick={(event) => onOpenHow(event.currentTarget)}
          className={cn("text-left hover:underline", FINANCE_FOCUS_CLASS)}
          data-testid="finance-hero"
        >
          {value}
        </button>
      ) : (
        <p data-testid="finance-hero">{value}</p>
      )}
      <p className="text-[13px] text-muted-foreground">{view.caveat}</p>
      {view.partialNote ? <p className="text-[13px] text-muted-foreground">{view.partialNote}</p> : null}
      {view.errorText ? <p className="text-[13px] text-muted-foreground">{view.errorText}</p> : null}
      {view.margin ? (
        <p className="flex flex-wrap items-center gap-x-1 text-sm">
          <span>{view.margin.text}</span>
          {view.margin.change ? (
            <span className="inline-flex items-center gap-0.5 text-muted-foreground">
              <span aria-hidden="true">·</span>
              <DeltaIcon direction={view.margin.change.direction} />
              {view.margin.change.text}
            </span>
          ) : null}
          <FinanceInfoButton label="About the margin" text={FINANCE_INFO_TEXT.margin} />
        </p>
      ) : null}
    </div>
  );
}

function AnswerCoverage({ view }: { view: FinanceAnswerView }) {
  const { coverage } = view;
  return (
    <div className="space-y-1">
      <div
        role="meter"
        aria-label="Costs complete"
        aria-valuemin={0}
        aria-valuemax={coverage.total}
        aria-valuenow={coverage.done}
        aria-valuetext={coverage.valueText}
        className="flex h-1 w-full overflow-hidden rounded-full bg-muted"
      >
        <div className="h-1 bg-muted-foreground" style={weightStyle(coverage.done, 0)} />
        <div className="h-1" style={weightStyle(coverage.remaining, 0)} />
      </div>
      <p className="flex items-center gap-1 text-sm">
        <span>{coverage.text}</span>
        <FinanceInfoButton label="What fully costed means" text={FINANCE_INFO_TEXT.fullyCosted} />
      </p>
      {coverage.waitingText ? <p className="text-[13px] text-muted-foreground">{coverage.waitingText}</p> : null}
    </div>
  );
}

/** The composition bar, its brackets, the legend table and the bridge line (spec §3.2, §6, §7 loss). */
function FinanceBar({ bar, bridge }: { bar: FinanceBarView; bridge: string | null }) {
  return (
    <div className="min-w-0 space-y-3">
      <div>
        <h3 className="text-sm font-medium">{bar.title}</h3>
        {bar.header ? <p className="text-[13px] text-muted-foreground">{bar.header}</p> : null}
      </div>
      <div className="space-y-1">
        <div
          role="img"
          aria-label={bar.ariaLabel}
          data-testid="finance-bar"
          className={cn("relative flex h-3 w-full gap-[2px] overflow-hidden rounded-[4px] bg-card", bar.layout === "empty" && FINANCE_SEGMENT_CLASSES.waiting)}
        >
          {bar.segments
            .filter((segment) => segment.weight > 0)
            .map((segment) => (
              <div key={segment.key} className={cn("h-full", FINANCE_SEGMENT_CLASSES[segment.key])} style={weightStyle(segment.weight, MIN_SLIVER_PX)} />
            ))}
          {bar.billedTickWeight !== null ? (
            // The tick sits at billed ÷ scale; the browser does the division in CSS from two integers.
            <div
              aria-hidden="true"
              className="absolute inset-y-0 w-[2px] bg-foreground"
              style={{ left: `calc(100% * ${bar.billedTickWeight} / 10000)` }}
            />
          ) : null}
        </div>
        {bar.brackets.length > 0 ? (
          <div className="flex gap-[2px]" aria-hidden="true">
            {bar.brackets.map((bracket) => (
              <div key={bracket.label} className="truncate border-t border-border pt-1 text-xs text-muted-foreground" style={weightStyle(bracket.weight, MIN_SLIVER_PX)}>
                {bracket.label}
              </div>
            ))}
          </div>
        ) : null}
        {bar.emptyLabel ? <p className="text-[13px] text-muted-foreground">{bar.emptyLabel}</p> : null}
        {bar.lossLabel ? <p className={cn("text-[13px] font-medium", FINANCE_LOSS_TEXT_CLASS)}>{bar.lossLabel}</p> : null}
      </div>
      {bar.legend.length > 0 ? (
        <table className="w-full text-sm" data-testid="finance-bar-legend">
          <caption className="sr-only">{bar.title}: the exact amounts behind the bar</caption>
          <thead>
            <tr className="text-xs text-muted-foreground">
              <th scope="col" className="text-left font-medium">
                <span className="sr-only">Part</span>
              </th>
              <th scope="col" className="w-16 text-right font-medium">
                {bar.centsCaption ?? <span className="sr-only">Of each dollar</span>}
              </th>
              <th scope="col" className="w-32 text-right font-medium">
                <span className="sr-only">Amount</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {bar.legend.map((row) => (
              <tr key={row.key}>
                <th scope="row" className="py-1 text-left font-normal">
                  <span className="inline-flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={cn(
                        "h-2.5 w-2.5 shrink-0 rounded-sm",
                        row.swatch ? FINANCE_SEGMENT_CLASSES[row.swatch] : "border border-dashed border-border",
                        row.swatch === "waiting" && "border border-border",
                      )}
                    />
                    {row.label}
                  </span>
                </th>
                <td className="py-1 text-right tabular-nums text-muted-foreground">{row.cents ?? ""}</td>
                <td className="w-32 whitespace-nowrap py-1 text-right tabular-nums">{row.amount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {bridge ? <p className="text-[13px] text-muted-foreground" data-testid="finance-bridge">{bridge}</p> : null}
    </div>
  );
}

function DeltaIcon({ direction, className }: { direction: "up" | "down" | "flat" | "none"; className?: string }) {
  if (direction === "up") return <ArrowUpRight aria-hidden="true" className={cn("h-3.5 w-3.5 shrink-0", className)} />;
  if (direction === "down") return <ArrowDownRight aria-hidden="true" className={cn("h-3.5 w-3.5 shrink-0", className)} />;
  return null;
}

/** The hero, coverage and bar at their final heights, while the first numbers load (spec §7). */
export function FinanceAnswerSkeleton() {
  return (
    <section aria-label="What we kept" aria-busy="true" data-testid="finance-answer-loading" className="rounded-md border bg-card p-5">
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-3">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-10 w-48 sm:h-12" />
          <Skeleton className="h-4 w-64" />
          <Skeleton className="h-4 w-56" />
          <Skeleton className="h-1 w-full" />
          <Skeleton className="h-4 w-48" />
        </div>
        <div className="space-y-3">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      </div>
    </section>
  );
}

// ── tiles ────────────────────────────────────────────────────────────────

/**
 * The four tiles. In part 1 they open nothing, so they are plain cards, not
 * buttons; the list sheets they will open come with part 2.
 */
export function FinanceTiles({ tiles, onOpenChecks }: { tiles: readonly FinanceTileView[]; onOpenChecks: () => void }) {
  return (
    <section aria-label="Totals" data-testid="finance-tiles" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {tiles.map((tile) => (
        <div key={tile.key} data-testid={`finance-tile-${tile.key}`} className="@container min-w-0 rounded-md border bg-card p-4">
          <div className="flex items-start gap-1">
            <h3 className="min-w-0 flex-1 text-[13px] font-normal text-muted-foreground">{tile.label}</h3>
            {tile.info ? <FinanceInfoButton label={`About ${tile.label.toLowerCase()}`} text={tile.info} /> : null}
            <FinanceCheckDots dots={tile.checkDots} onOpenChecks={onOpenChecks} />
          </div>
          <p className="mt-1 whitespace-nowrap text-2xl font-semibold leading-8" style={tileValueStyle(tile.value)} data-testid="finance-tile-value">
            {tile.value}
          </p>
          <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
            {/* Icons sit on the first line: in a narrow tile the words wrap, and a centred icon would drift down beside the second. */}
            {tile.delta ? (
              <p className="flex items-start gap-0.5">
                <DeltaIcon direction={tile.delta.direction} className="mt-px" />
                <span>{tile.delta.text}</span>
              </p>
            ) : null}
            {tile.subLines.map((line) => (
              <p key={line.text} className="flex items-start gap-1">
                {line.icon === "clock" ? <Clock aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0" /> : null}
                <span>{line.text}</span>
              </p>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

export function FinanceTilesSkeleton() {
  return (
    <section aria-label="Totals" aria-busy="true" data-testid="finance-tiles-loading" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="space-y-2 rounded-md border bg-card p-4">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-3 w-20" />
        </div>
      ))}
    </section>
  );
}
