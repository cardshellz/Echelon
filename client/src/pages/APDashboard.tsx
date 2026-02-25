import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AlertTriangle, Clock, DollarSign, CheckCircle, Plus, FileText } from "lucide-react";

function formatCents(cents: number | null | undefined): string {
  if (!cents && cents !== 0) return "$0.00";
  return `$${(Number(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

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
          <Link href="/ap-invoices/new">
            <Button size="sm">
              <Plus className="h-4 w-4 mr-2" />
              New Invoice
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

        <Card>
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

      {/* Aging Buckets */}
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

      {/* Vendor Aging Table */}
      {vendorAging.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">By Vendor</CardTitle>
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

      {vendorAging.length === 0 && !isLoading && (
        <div className="text-center py-16 text-muted-foreground">
          <DollarSign className="h-12 w-12 mx-auto mb-3 opacity-20" />
          <p className="text-sm">No outstanding invoices</p>
          <Link href="/ap-invoices/new">
            <Button variant="outline" size="sm" className="mt-4">Create your first invoice</Button>
          </Link>
        </div>
      )}
    </div>
  );
}
