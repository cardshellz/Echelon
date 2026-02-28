import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AlertTriangle, Clock, DollarSign, CheckCircle, Plus, FileText, CreditCard } from "lucide-react";
import { format, parseISO } from "date-fns";

function formatCents(cents: number | null | undefined): string {
  if (!cents && cents !== 0) return "$0.00";
  return `$${(Number(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(d: string | null | undefined) {
  if (!d) return "—";
  try { return format(parseISO(d), "MMM d, yyyy"); } catch { return d; }
}

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  ach: "ACH",
  wire: "Wire",
  check: "Check",
  credit_card: "Credit Card",
  other: "Other",
};

export default function APDashboard() {
  const { data: summary, isLoading } = useQuery<any>({
    queryKey: ["/api/ap/summary"],
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  const agingBuckets = summary?.agingBuckets ?? {};
  const vendorAging: any[] = summary?.vendorAging ?? [];
  const recentPayments: any[] = summary?.recentPayments ?? [];
  const recentlyPaid: any[] = summary?.recentlyPaid ?? [];
  const hasOutstanding = summary?.totalOutstandingCents > 0;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Accounts Payable</h1>
          <p className="text-muted-foreground text-sm">Outstanding invoices and payment overview</p>
        </div>
        <div className="flex gap-2">
          <Link href="/ap-invoices">
            <Button variant="outline" size="sm">
              <FileText className="h-4 w-4 mr-2" />
              All Invoices
            </Button>
          </Link>
          <Link href="/ap-payments">
            <Button variant="outline" size="sm">
              <CreditCard className="h-4 w-4 mr-2" />
              Payments
            </Button>
          </Link>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total Outstanding</p>
                <p className="text-2xl font-bold mt-1">{formatCents(summary?.totalOutstandingCents)}</p>
                {(summary?.openInvoiceCount ?? 0) > 0 && (
                  <p className="text-xs text-muted-foreground mt-1">{summary.openInvoiceCount} open invoice{summary.openInvoiceCount !== 1 ? "s" : ""}</p>
                )}
              </div>
              <DollarSign className="h-5 w-5 text-muted-foreground mt-1" />
            </div>
          </CardContent>
        </Card>

        <Card className={summary?.overdueCents > 0 ? "border-red-200" : ""}>
          <CardContent className="pt-6">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Overdue</p>
                <p className={`text-2xl font-bold mt-1 ${summary?.overdueCents > 0 ? "text-red-600" : ""}`}>
                  {formatCents(summary?.overdueCents)}
                </p>
              </div>
              <AlertTriangle className={`h-5 w-5 mt-1 ${summary?.overdueCents > 0 ? "text-red-500" : "text-muted-foreground"}`} />
            </div>
          </CardContent>
        </Card>

        <Card className={summary?.dueSoonCents > 0 ? "border-amber-200" : ""}>
          <CardContent className="pt-6">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Due Within 7 Days</p>
                <p className={`text-2xl font-bold mt-1 ${summary?.dueSoonCents > 0 ? "text-amber-600" : ""}`}>
                  {formatCents(summary?.dueSoonCents)}
                </p>
              </div>
              <Clock className={`h-5 w-5 mt-1 ${summary?.dueSoonCents > 0 ? "text-amber-500" : "text-muted-foreground"}`} />
            </div>
          </CardContent>
        </Card>

        <Card className={summary?.paidThisMonthCents > 0 ? "border-green-200" : ""}>
          <CardContent className="pt-6">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Paid This Month</p>
                <p className="text-2xl font-bold mt-1 text-green-600">{formatCents(summary?.paidThisMonthCents)}</p>
              </div>
              <CheckCircle className="h-5 w-5 text-green-500 mt-1" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Aging Buckets — only show if there's outstanding balance */}
      {hasOutstanding && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">AP Aging Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-5 gap-4 text-center">
              {[
                { label: "Current", key: "current", color: "text-green-600" },
                { label: "1-30 Days", key: "days1_30", color: "text-amber-500" },
                { label: "31-60 Days", key: "days31_60", color: "text-orange-500" },
                { label: "61-90 Days", key: "days61_90", color: "text-red-500" },
                { label: "90+ Days", key: "days90plus", color: "text-red-700" },
              ].map(({ label, key, color }) => (
                <div key={key} className="space-y-1">
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className={`text-lg font-bold ${agingBuckets[key] > 0 ? color : "text-muted-foreground"}`}>
                    {formatCents(agingBuckets[key] ?? 0)}
                  </p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Vendor Aging Table — only show if there's outstanding balance */}
      {vendorAging.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Outstanding by Vendor</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Vendor</TableHead>
                  <TableHead className="text-right">Current</TableHead>
                  <TableHead className="text-right">1-30d</TableHead>
                  <TableHead className="text-right">31-60d</TableHead>
                  <TableHead className="text-right">61-90d</TableHead>
                  <TableHead className="text-right">90+d</TableHead>
                  <TableHead className="text-right font-semibold">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {vendorAging
                  .sort((a: any, b: any) => b.total - a.total)
                  .map((v: any) => (
                    <TableRow key={v.vendorId}>
                      <TableCell className="font-medium">{v.vendorName}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{v.current > 0 ? formatCents(v.current) : "—"}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{v.days1_30 > 0 ? <span className="text-amber-600">{formatCents(v.days1_30)}</span> : "—"}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{v.days31_60 > 0 ? <span className="text-orange-600">{formatCents(v.days31_60)}</span> : "—"}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{v.days61_90 > 0 ? <span className="text-red-600">{formatCents(v.days61_90)}</span> : "—"}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{v.days90plus > 0 ? <span className="text-red-700 font-bold">{formatCents(v.days90plus)}</span> : "—"}</TableCell>
                      <TableCell className="text-right font-mono font-semibold">{formatCents(v.total)}</TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Recent Payments */}
      {recentPayments.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent Payments</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Payment #</TableHead>
                  <TableHead>Vendor</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentPayments.map((p: any) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-mono text-sm">{p.paymentNumber}</TableCell>
                    <TableCell>{p.vendorName ?? "—"}</TableCell>
                    <TableCell className="text-sm">{formatDate(p.paymentDate)}</TableCell>
                    <TableCell className="text-sm">{PAYMENT_METHOD_LABELS[p.paymentMethod] ?? p.paymentMethod}</TableCell>
                    <TableCell className="text-right font-mono font-medium">{formatCents(p.totalAmountCents)}</TableCell>
                    <TableCell>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                        p.status === "completed" ? "bg-green-100 text-green-700" :
                        p.status === "voided" ? "bg-slate-100 text-slate-400" :
                        "bg-blue-100 text-blue-700"
                      }`}>
                        {p.status}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Recently Paid Invoices */}
      {recentlyPaid.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recently Paid Invoices</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice #</TableHead>
                  <TableHead>Vendor</TableHead>
                  <TableHead className="text-right">Invoice Amount</TableHead>
                  <TableHead className="text-right">Paid</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentlyPaid.map((inv: any) => (
                  <TableRow key={inv.id} className="cursor-pointer hover:bg-muted/50">
                    <TableCell>
                      <Link href={`/ap-invoices/${inv.id}`}>
                        <span className="font-mono text-sm text-primary hover:underline">{inv.invoiceNumber}</span>
                      </Link>
                    </TableCell>
                    <TableCell>{inv.vendorName ?? "—"}</TableCell>
                    <TableCell className="text-right font-mono text-sm">{formatCents(inv.invoicedAmountCents)}</TableCell>
                    <TableCell className="text-right font-mono text-sm text-green-600">{formatCents(inv.paidAmountCents)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Empty state — only when nothing at all */}
      {!hasOutstanding && recentPayments.length === 0 && recentlyPaid.length === 0 && (
        <div className="text-center py-16 text-muted-foreground">
          <DollarSign className="h-12 w-12 mx-auto mb-3 opacity-20" />
          <p className="text-sm">No AP activity yet</p>
          <Link href="/ap-invoices">
            <Button variant="outline" size="sm" className="mt-4">Go to Invoices</Button>
          </Link>
        </div>
      )}
    </div>
  );
}
