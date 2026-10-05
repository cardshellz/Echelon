/**
 * "The detail": nine quiet rows, each with one amount, that open in place
 * into plain-word statement lines (spec §3.4, §12).
 *
 * The rows are a Radix accordion (several can be open; Enter/Space toggles,
 * arrows move between rows). The header is an h3 with the chevron first.
 * Statement lines are a real table with a caption: the first cell is the
 * row header, the + − = column is hidden from screen readers and the line
 * says "minus" or "plus" itself.
 *
 * In part 1 a line shows its amount with no link; part 2 adds the list
 * sheet behind each line. The only line action here is "How this is worked
 * out" on a line that carries server workings.
 */

import React from "react";
import * as AccordionPrimitive from "@radix-ui/react-accordion";
import { ChevronDown, ChevronRight, Clock, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import {
  FINANCE_DEPTH_LABELS,
  FINANCE_DETAIL_TITLE,
  FINANCE_HOW_LINK_TEXT,
  FINANCE_ROUNDING_LABEL,
  FINANCE_ROUNDING_NOTE,
  isFinanceDetailKey,
  type FinanceChecksView,
  type FinanceDepth,
  type FinanceDetailGroupView,
  type FinanceDetailKey,
  type FinanceDetailRowView,
  type FinanceMemoView,
  type FinanceProductRowView,
  type FinanceProductsTableView,
  type FinanceStatementRowView,
  type FinanceStatementView,
  type FinanceVendorsTableView,
} from "../dropship-finance-model";
import type { FinanceLineKey } from "@shared/dropship/program-finance";
import {
  FINANCE_FOCUS_CLASS,
  FINANCE_LOSS_TEXT_CLASS,
  FINANCE_TEXT_BUTTON_CLASS,
  FINANCE_TONE_TEXT_CLASSES,
  FinanceCheckDots,
  FinanceClockChip,
  FinanceInfoButton,
  FinanceToneIcon,
} from "./finance-ui";

/** Lines whose negative figure is a loss and reads in red (spec §6); other negatives stay plain ink. */
const LOSS_LINE_KEYS: ReadonlySet<string> = new Set(["sales.kept", "sales.kept_orders"]);

const ROW_AMOUNT_TONES = {
  default: "text-foreground",
  muted: "text-muted-foreground",
  loss: FINANCE_LOSS_TEXT_CLASS,
  fine: FINANCE_TONE_TEXT_CLASSES.fine,
  attention: FINANCE_TONE_TEXT_CLASSES.attention,
} as const;

export interface FinanceDetailProps {
  readonly groups: readonly FinanceDetailGroupView[];
  readonly rows: Readonly<Partial<Record<FinanceDetailKey, FinanceDetailRowView>>>;
  readonly products: FinanceProductsTableView | null;
  readonly vendors: FinanceVendorsTableView | null;
  readonly checks: FinanceChecksView | null;
  readonly open: readonly FinanceDetailKey[];
  readonly depth: FinanceDepth;
  readonly onOpenChange: (open: FinanceDetailKey[]) => void;
  readonly onDepthChange: (depth: FinanceDepth) => void;
  readonly onOpenHow: (key: FinanceLineKey) => void;
  readonly onOpenChecks: () => void;
  readonly onScopeVendor: (vendorId: number) => void;
  readonly onRetry: () => void;
}

export function FinanceDetail(props: FinanceDetailProps) {
  return (
    <section aria-labelledby="finance-detail-title" data-testid="finance-detail" className="space-y-2">
      <DetailHeader depth={props.depth} onDepthChange={props.onDepthChange} />
      <AccordionPrimitive.Root
        type="multiple"
        value={[...props.open]}
        onValueChange={(value) => props.onOpenChange(value.filter(isFinanceDetailKey))}
        className="space-y-4"
      >
        {props.groups.map((group) => (
          <div key={group.group}>
            <p className="pb-1 text-xs font-medium text-muted-foreground">{group.caption}</p>
            <div className="rounded-md border bg-card px-4">
              {group.keys.map((key) => {
                const row = props.rows[key];
                return row ? <DetailRow key={key} row={row} {...props} /> : null;
              })}
            </div>
          </div>
        ))}
      </AccordionPrimitive.Root>
    </section>
  );
}

function DetailHeader({ depth, onDepthChange }: { depth: FinanceDepth; onDepthChange: (depth: FinanceDepth) => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 id="finance-detail-title" className="text-base font-semibold">
        {FINANCE_DETAIL_TITLE}
      </h2>
      <ToggleGroup
        type="single"
        value={depth}
        onValueChange={(value) => {
          // Radix sends "" when the pressed item is pressed again; the depth always has a value.
          if (value === "summary" || value === "every_line") onDepthChange(value);
        }}
        aria-label="How many lines to show"
        className="rounded-md border border-border p-0.5"
      >
        <ToggleGroupItem value="summary" size="sm" className="min-h-8 px-3 text-xs">
          {FINANCE_DEPTH_LABELS.summary}
        </ToggleGroupItem>
        <ToggleGroupItem value="every_line" size="sm" className="min-h-8 px-3 text-xs">
          {FINANCE_DEPTH_LABELS.every_line}
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}

function DetailRow({ row, ...props }: FinanceDetailProps & { row: FinanceDetailRowView }) {
  return (
    <AccordionPrimitive.Item value={row.key} id={`finance-detail-${row.key}`} data-testid={`finance-detail-${row.key}`} className="scroll-mt-28 border-b last:border-b-0">
      <AccordionPrimitive.Header className="flex">
        <AccordionPrimitive.Trigger
          className={cn("group flex min-h-12 flex-1 items-center gap-3 py-3 text-left hover:no-underline", FINANCE_FOCUS_CLASS)}
        >
          <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-90 motion-reduce:transition-none" />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
            <span className="text-sm font-semibold">{row.title}</span>
            {row.summary ? <span className="hidden truncate text-[13px] text-muted-foreground sm:inline">{row.summary}</span> : null}
          </span>
          <span className={cn("shrink-0 text-right text-sm font-semibold tabular-nums", ROW_AMOUNT_TONES[row.amountTone])}>
            {row.key === "checks" && (row.amountTone === "fine" || row.amountTone === "attention") ? (
              <span className="inline-flex items-center gap-1">
                <FinanceToneIcon tone={row.amountTone} className="h-3.5 w-3.5" />
                {row.amount}
              </span>
            ) : (
              row.amount
            )}
          </span>
        </AccordionPrimitive.Trigger>
      </AccordionPrimitive.Header>
      <AccordionPrimitive.Content className="overflow-hidden data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down motion-reduce:animate-none">
        {/* On a phone the body drops the indent under the chevron: the statement needs the width more. */}
        <div className="space-y-4 pb-4 sm:pl-7">
          {row.chip ? <FinanceClockChip text={row.chip} /> : null}
          <DetailRowBody row={row} {...props} />
        </div>
      </AccordionPrimitive.Content>
    </AccordionPrimitive.Item>
  );
}

function DetailRowBody({ row, ...props }: FinanceDetailProps & { row: FinanceDetailRowView }) {
  if (row.state !== "ok") {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-muted-foreground">{row.errorText}</p>
        <Button size="sm" variant="outline" data-finance-action="retry" onClick={props.onRetry}>
          Try again
        </Button>
      </div>
    );
  }
  if (row.key === "checks") return props.checks ? <FinanceChecksList view={props.checks} /> : null;
  return (
    <>
      {row.statements.map((statement) => (
        <StatementTable key={statement.caption} statement={statement} onOpenHow={props.onOpenHow} onOpenChecks={props.onOpenChecks} />
      ))}
      {row.key === "products" && props.products ? <ProductsTable table={props.products} /> : null}
      {row.key === "vendors" && props.vendors ? <VendorsTable table={props.vendors} onScopeVendor={props.onScopeVendor} /> : null}
      {row.memos.length > 0 ? <MemoList memos={row.memos} onOpenChecks={props.onOpenChecks} /> : null}
    </>
  );
}

function StatementTable({
  statement,
  onOpenHow,
  onOpenChecks,
}: {
  statement: FinanceStatementView;
  onOpenHow: (key: FinanceLineKey) => void;
  onOpenChecks: () => void;
}) {
  if (statement.rows.length === 0) return null;
  return (
    <div className="space-y-1">
      <table className="w-full text-sm">
        {/* A statement with its own heading shows the caption; the others keep it for screen readers only. */}
        <caption className={statement.heading ? "pb-1 text-left text-sm font-semibold" : "sr-only"}>{statement.heading ?? statement.caption}</caption>
        <tbody>
          {statement.rows.map((row) => (
            <StatementRow key={row.key} row={row} onOpenHow={onOpenHow} onOpenChecks={onOpenChecks} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatementRow({
  row,
  onOpenHow,
  onOpenChecks,
}: {
  row: FinanceStatementRowView;
  onOpenHow: (key: FinanceLineKey) => void;
  onOpenChecks: () => void;
}) {
  const loss = row.negative && LOSS_LINE_KEYS.has(row.key);
  return (
    <tr
      className={cn(
        "relative align-top",
        row.emphasis === "subtotal" && "border-t border-border",
        row.emphasis === "result" && "border-b-[3px] border-t border-double border-border font-semibold",
      )}
    >
      <td aria-hidden="true" className="w-4 py-2 text-center text-xs text-muted-foreground">
        {row.operatorSymbol}
      </td>
      <th scope="row" className="py-2 pl-2 pr-3 text-left font-normal">
        <span className={cn(row.emphasis !== "none" && "font-semibold")}>
          {row.operatorWords ? <span className="sr-only">{row.operatorWords} </span> : null}
          {row.label}
        </span>
        <FinanceCheckDots dots={row.checkDots} onOpenChecks={onOpenChecks} />
        {row.hasWorkings ? (
          <button
            type="button"
            data-finance-action="open-how"
            onClick={() => onOpenHow(row.key)}
            className={cn(FINANCE_TEXT_BUTTON_CLASS, "ml-2 text-xs font-normal text-muted-foreground")}
          >
            {FINANCE_HOW_LINK_TEXT} ›
          </button>
        ) : null}
        {row.subLines.map((line) => (
          <span key={line} className="block pl-3 pt-0.5 text-[13px] font-normal text-muted-foreground sm:pl-6">
            {line}
          </span>
        ))}
      </th>
      {/* A minimum width only: the amount never wraps, so a longer figure widens its column. */}
      <td className={cn("w-20 whitespace-nowrap py-2 text-right tabular-nums sm:w-32", row.status !== "recorded" && "text-muted-foreground", loss && FINANCE_LOSS_TEXT_CLASS)}>
        <span className="inline-flex items-center justify-end gap-0.5">
          {row.amount}
          {row.info ? <FinanceInfoButton label={`Why ${row.label.toLowerCase()} is not recorded`} text={row.info} /> : null}
        </span>
      </td>
    </tr>
  );
}

const MEMO_ICONS = {
  clock: <Clock aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />,
  info: <Info aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />,
  fine: <FinanceToneIcon tone="fine" className="mt-0.5 h-3.5 w-3.5" />,
  attention: <FinanceToneIcon tone="attention" className="mt-0.5 h-3.5 w-3.5" />,
} as const;

function MemoList({ memos, onOpenChecks }: { memos: readonly FinanceMemoView[]; onOpenChecks: () => void }) {
  return (
    <ul className="space-y-1 text-[13px] text-muted-foreground">
      {memos.map((memo) => (
        <li key={memo.key} className="flex items-start gap-1.5">
          {memo.icon !== "none" ? MEMO_ICONS[memo.icon] : null}
          <span>{memo.text}</span>
          {memo.info ? <FinanceInfoButton label={`About: ${memo.text}`} text={memo.info} /> : null}
          <FinanceCheckDots dots={memo.checkDots} onOpenChecks={onOpenChecks} />
        </li>
      ))}
    </ul>
  );
}

// ── products and vendors tables ──────────────────────────────────────────

const AMOUNT_CELL = "w-32 whitespace-nowrap text-right tabular-nums";

function ProductCells({ row }: { row: FinanceProductRowView }) {
  return (
    <>
      <TableCell className="text-right tabular-nums">{row.packs}</TableCell>
      <TableCell className={AMOUNT_CELL}>{row.billed}</TableCell>
      <TableCell className={AMOUNT_CELL}>{row.billedFullyCosted}</TableCell>
      <TableCell className={AMOUNT_CELL}>{row.costOfGoods}</TableCell>
      <TableCell className={cn(AMOUNT_CELL, row.keptNegative && FINANCE_LOSS_TEXT_CLASS)}>{row.kept}</TableCell>
    </>
  );
}

function ProductsTable({ table }: { table: FinanceProductsTableView }) {
  return (
    <div className="space-y-2">
      <Table className="text-sm">
        <caption className="sr-only">{table.caption}</caption>
        <TableHeader>
          <TableRow className="text-xs">
            <TableHead className="h-9 font-medium">Product</TableHead>
            <TableHead className="h-9 text-right font-medium">Packs</TableHead>
            <TableHead className="h-9 text-right font-medium">Billed for product</TableHead>
            <TableHead className="h-9 text-right font-medium">Billed on fully costed orders</TableHead>
            <TableHead className="h-9 text-right font-medium">Cost of goods</TableHead>
            <TableHead className="h-9 text-right font-medium">Kept on product</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {table.rows.map((row) => (
            <TableRow key={row.key}>
              <TableCell>
                <span className="block font-medium">{row.product}</span>
                {row.detail ? <span className="block text-xs text-muted-foreground">{row.detail}</span> : null}
              </TableCell>
              <ProductCells row={row} />
            </TableRow>
          ))}
          {table.others ? (
            <TableRow>
              <TableCell className="text-muted-foreground">{table.others.product}</TableCell>
              <ProductCells row={table.others} />
            </TableRow>
          ) : null}
          {table.unlinked ? (
            <TableRow>
              <TableCell className="text-muted-foreground">{table.unlinked.label}</TableCell>
              <TableCell />
              <TableCell />
              <TableCell />
              <TableCell className={AMOUNT_CELL}>{table.unlinked.costOfGoods}</TableCell>
              <TableCell />
            </TableRow>
          ) : null}
          {table.rounding ? (
            <TableRow className="text-muted-foreground">
              <TableCell>
                {FINANCE_ROUNDING_LABEL}
                <span className="block text-xs">{FINANCE_ROUNDING_NOTE}</span>
              </TableCell>
              <TableCell />
              <TableCell />
              <TableCell />
              <TableCell className={AMOUNT_CELL}>{table.rounding.costOfGoods}</TableCell>
              <TableCell className={AMOUNT_CELL}>{table.rounding.kept}</TableCell>
            </TableRow>
          ) : null}
        </TableBody>
        {table.total ? (
          <TableFooter>
            <TableRow className="font-semibold">
              <TableCell>{table.total.product}</TableCell>
              <ProductCells row={table.total} />
            </TableRow>
          </TableFooter>
        ) : null}
      </Table>
      {table.footer.length > 0 ? <p className="text-[13px] text-muted-foreground">{table.footer.join(" · ")}</p> : null}
    </div>
  );
}

function VendorsTable({ table, onScopeVendor }: { table: FinanceVendorsTableView; onScopeVendor: (vendorId: number) => void }) {
  return (
    <Table className="text-sm">
      <caption className="sr-only">{table.caption}</caption>
      <TableHeader>
        <TableRow className="text-xs">
          <TableHead className="h-9 font-medium">Vendor</TableHead>
          <TableHead className="h-9 text-right font-medium">Orders</TableHead>
          <TableHead className="h-9 text-right font-medium">Billed</TableHead>
          <TableHead className="h-9 text-right font-medium">Kept</TableHead>
          <TableHead className="h-9 text-right font-medium">We owe now</TableHead>
          <TableHead className="h-9 text-right font-medium">They owe now</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {table.rows.map((row) => (
          <TableRow key={row.vendorId}>
            <TableCell>
              <button
                type="button"
                data-finance-action="scope-vendor"
                aria-label={`Show ${row.name}'s view: this page for ${row.name} only`}
                onClick={() => onScopeVendor(row.vendorId)}
                className={cn(FINANCE_TEXT_BUTTON_CLASS, "font-medium")}
              >
                {row.name}
              </button>
            </TableCell>
            <TableCell className="text-right tabular-nums">{row.orders}</TableCell>
            <TableCell className={AMOUNT_CELL}>{row.billed}</TableCell>
            <TableCell className={cn(AMOUNT_CELL, row.keptNegative && FINANCE_LOSS_TEXT_CLASS)}>{row.kept}</TableCell>
            <TableCell className={AMOUNT_CELL}>{row.weOwe}</TableCell>
            <TableCell className={AMOUNT_CELL}>{row.theyOwe}</TableCell>
          </TableRow>
        ))}
        {table.others ? (
          <TableRow>
            <TableCell className="text-muted-foreground">{table.others.label}</TableCell>
            <TableCell className="text-right tabular-nums">{table.others.orders}</TableCell>
            <TableCell className={AMOUNT_CELL}>{table.others.billed}</TableCell>
            <TableCell className={AMOUNT_CELL}>{table.others.kept}</TableCell>
            <TableCell className={AMOUNT_CELL}>{table.others.weOwe}</TableCell>
            <TableCell className={AMOUNT_CELL}>{table.others.theyOwe}</TableCell>
          </TableRow>
        ) : null}
        {table.rounding ? (
          <TableRow className="text-muted-foreground">
            <TableCell colSpan={3}>
              {FINANCE_ROUNDING_LABEL}
              <span className="block text-xs">{FINANCE_ROUNDING_NOTE}</span>
            </TableCell>
            <TableCell className={AMOUNT_CELL}>{table.rounding.kept}</TableCell>
            <TableCell />
            <TableCell />
          </TableRow>
        ) : null}
      </TableBody>
      {table.total ? (
        <TableFooter>
          <TableRow className="font-semibold">
            <TableCell>{table.total.label}</TableCell>
            <TableCell className="text-right tabular-nums">{table.total.orders}</TableCell>
            <TableCell className={AMOUNT_CELL}>{table.total.billed}</TableCell>
            <TableCell className={AMOUNT_CELL}>{table.total.kept}</TableCell>
            <TableCell className={AMOUNT_CELL}>{table.total.weOwe}</TableCell>
            <TableCell className={AMOUNT_CELL}>{table.total.theyOwe}</TableCell>
          </TableRow>
        </TableFooter>
      ) : null}
    </Table>
  );
}

// ── checks (spec §8) ─────────────────────────────────────────────────────

export function FinanceChecksList({ view }: { view: FinanceChecksView }) {
  return (
    <div data-testid="finance-checks" className="space-y-3">
      {view.scopeNote ? <p className="text-[13px] text-muted-foreground">{view.scopeNote}</p> : null}
      <p className="text-[13px] text-muted-foreground">Every check runs on the same snapshot as the numbers above.</p>
      {view.groups.map((group) => (
        <Collapsible key={group.group} defaultOpen={group.defaultOpen}>
          <CollapsibleTrigger
            className={cn("group flex min-h-11 w-full items-center gap-2 text-left text-sm font-medium", FINANCE_FOCUS_CLASS)}
          >
            <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 -rotate-90 text-muted-foreground transition-transform group-data-[state=open]:rotate-0 motion-reduce:transition-none" />
            <span>{group.title}</span>
            <span className="text-[13px] font-normal text-muted-foreground">{group.countText}</span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="space-y-2 pb-2 pl-6">
              {group.checks.map((check) => (
                <li key={check.id} className="flex items-start gap-2 text-sm">
                  <FinanceToneIcon tone={check.tone} className="mt-0.5" />
                  <span className="min-w-0">
                    <span className={cn("font-medium", FINANCE_TONE_TEXT_CLASSES[check.tone])}>{check.word}</span>
                    <span className="text-muted-foreground"> · </span>
                    <span>{check.wording}</span>
                    {check.detail ? <span className="block text-[13px] text-muted-foreground">{check.detail}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      ))}
      {view.info.length > 0 ? (
        <ul className="space-y-1 border-t border-border pt-3 text-[13px] text-muted-foreground" data-testid="finance-info-lines">
          {view.info.map((line) => (
            <li key={line.key} className="flex items-start gap-1.5">
              <Info aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{line.text}</span>
              {line.note ? <FinanceInfoButton label="About this information line" text={line.note} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ── loading ──────────────────────────────────────────────────────────────

/** The nine rows with their real titles and skeleton amounts while the first numbers load (spec §7). */
export function FinanceDetailSkeleton({ groups, titles }: { groups: readonly FinanceDetailGroupView[]; titles: (key: FinanceDetailKey) => string }) {
  return (
    <section aria-label={FINANCE_DETAIL_TITLE} aria-busy="true" data-testid="finance-detail-loading" className="space-y-4">
      <h2 className="text-base font-semibold">{FINANCE_DETAIL_TITLE}</h2>
      {groups.map((group) => (
        <div key={group.group}>
          <p className="pb-1 text-xs font-medium text-muted-foreground">{group.caption}</p>
          <ul className="rounded-md border bg-card px-4">
            {group.keys.map((key) => (
              <li key={key} className="flex min-h-12 items-center gap-3 border-b py-3 last:border-b-0">
                <span className="pl-7 text-sm font-semibold">{titles(key)}</span>
                <Skeleton className="ml-auto h-4 w-24" />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
