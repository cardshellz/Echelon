import React from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import { apSummarySchema, type ApSummary } from "@shared/procurement/ap-summary";
import { formatPaymentAmount } from "@/lib/ap-payment-command";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AlertTriangle, CheckCircle, Clock, DollarSign } from "lucide-react";
import APDashboard from "./APDashboard";
import APInvoices from "./APInvoices";
import APPayments from "./APPayments";
import SupplierCredits from "./SupplierCredits";
import SupplierReturns from "./SupplierReturns";

const BILLS_TABS = ["invoices", "payments", "credits", "returns", "overview"] as const;
type BillsTab = (typeof BILLS_TABS)[number];

function resolveBillsTab(search: string): BillsTab {
  const raw = new URLSearchParams(search).get("tab");
  return BILLS_TABS.includes(raw as BillsTab) ? (raw as BillsTab) : "invoices";
}

export default function PurchasingBillsHub() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const activeTab = resolveBillsTab(search);

  const { data: summary } = useQuery<ApSummary>({
    queryKey: ["/api/ap/summary"],
    queryFn: async ({ signal }) => {
      const response = await fetch("/api/ap/summary", { credentials: "include", signal });
      if (!response.ok) throw new Error("Accounts payable summary could not be loaded.");
      return apSummarySchema.parse(await response.json());
    },
  });

  function setTab(next: string) {
    const valid = BILLS_TABS.includes(next as BillsTab) ? (next as BillsTab) : "invoices";
    navigate(valid === "invoices" ? "/purchasing/bills" : `/purchasing/bills?tab=${valid}`);
  }

  return (
    <div className="space-y-4">
      <div className="border-b bg-card px-4 py-4 md:px-6">
        <div className="mx-auto max-w-7xl space-y-4">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="text-xl font-bold md:text-2xl">Bills &amp; Payments</h1>
              <p className="text-sm text-muted-foreground">
                Supplier commercial invoices, freight &amp; customs bills, wire payments, credits, and returns in one place
              </p>
            </div>
          </div>

          {summary && activeTab !== "overview" && (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Card className="shadow-none">
                <CardContent className="flex items-center justify-between p-3.5">
                  <div>
                    <p className="text-xs text-muted-foreground">Open Balance</p>
                    <p className="font-mono text-lg font-bold">
                      {formatPaymentAmount(summary.totalOutstandingCents)}
                    </p>
                  </div>
                  <DollarSign className="h-4 w-4 text-muted-foreground" />
                </CardContent>
              </Card>
              <Card className={`shadow-none ${summary.overdueCents > 0 ? "border-red-200" : ""}`}>
                <CardContent className="flex items-center justify-between p-3.5">
                  <div>
                    <p className="text-xs text-muted-foreground">Overdue</p>
                    <p className={`font-mono text-lg font-bold ${summary.overdueCents > 0 ? "text-red-600" : ""}`}>
                      {formatPaymentAmount(summary.overdueCents)}
                    </p>
                  </div>
                  <AlertTriangle className={`h-4 w-4 ${summary.overdueCents > 0 ? "text-red-500" : "text-muted-foreground"}`} />
                </CardContent>
              </Card>
              <Card className={`shadow-none ${summary.dueSoonCents > 0 ? "border-amber-200" : ""}`}>
                <CardContent className="flex items-center justify-between p-3.5">
                  <div>
                    <p className="text-xs text-muted-foreground">Due in 7 Days</p>
                    <p className={`font-mono text-lg font-bold ${summary.dueSoonCents > 0 ? "text-amber-600" : ""}`}>
                      {formatPaymentAmount(summary.dueSoonCents)}
                    </p>
                  </div>
                  <Clock className={`h-4 w-4 ${summary.dueSoonCents > 0 ? "text-amber-500" : "text-muted-foreground"}`} />
                </CardContent>
              </Card>
              <Card className="shadow-none">
                <CardContent className="flex items-center justify-between p-3.5">
                  <div>
                    <p className="text-xs text-muted-foreground">Paid This Month</p>
                    <p className="font-mono text-lg font-bold text-green-600">
                      {formatPaymentAmount(summary.paidThisMonthCents)}
                    </p>
                  </div>
                  <CheckCircle className="h-4 w-4 text-green-500" />
                </CardContent>
              </Card>
            </div>
          )}

          <Tabs value={activeTab} onValueChange={setTab}>
            <TabsList className="flex h-auto flex-wrap justify-start gap-1">
              <TabsTrigger value="invoices" data-testid="bills-tab-invoices">
                Vendor Bills &amp; Invoices
              </TabsTrigger>
              <TabsTrigger value="payments" data-testid="bills-tab-payments">
                Payments
              </TabsTrigger>
              <TabsTrigger value="credits" data-testid="bills-tab-credits">
                Supplier Credits
              </TabsTrigger>
              <TabsTrigger value="returns" data-testid="bills-tab-returns">
                Supplier Returns
              </TabsTrigger>
              <TabsTrigger value="overview" data-testid="bills-tab-overview">
                Aging &amp; Summary
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setTab}>
        <TabsContent value="invoices" className="m-0">
          <APInvoices />
        </TabsContent>
        <TabsContent value="payments" className="m-0">
          <APPayments />
        </TabsContent>
        <TabsContent value="credits" className="m-0">
          <SupplierCredits />
        </TabsContent>
        <TabsContent value="returns" className="m-0">
          <SupplierReturns />
        </TabsContent>
        <TabsContent value="overview" className="m-0">
          <APDashboard />
        </TabsContent>
      </Tabs>
    </div>
  );
}
