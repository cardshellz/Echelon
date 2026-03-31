// subscription.types.ts — TypeScript interfaces for the subscription engine

export interface SellingPlanConfig {
  name: string;
  options: string[];
  billingInterval: "MONTH" | "YEAR";
  billingIntervalCount: number;
  priceCents: number;
  tier: "standard" | "gold";
  includesDropship: boolean;
  planId: number; // maps to plans.id
}

export interface SellingPlanGroupResult {
  sellingPlanGroupGid: string;
  sellingPlans: Array<{
    gid: string;
    name: string;
  }>;
}

export interface ContractWebhookPayload {
  admin_graphql_api_id: string;
  id: number;
  billing_policy: {
    interval: string;
    interval_count: number;
    min_cycles?: number;
    max_cycles?: number | null;
  };
  currency_code: string;
  customer_id: number;
  admin_graphql_api_customer_id: string;
  delivery_policy: {
    interval: string;
    interval_count: number;
  };
  status: string;
  admin_graphql_api_origin_order_id?: string;
  origin_order_id?: number;
  revision_id?: string;
}

export interface BillingWebhookPayload {
  id: string;
  admin_graphql_api_id: string;
  subscription_contract_id: number;
  admin_graphql_api_subscription_contract_id: string;
  ready: boolean;
  order_id?: number | null;
  admin_graphql_api_order_id?: string | null;
  error_message?: string | null;
  error_code?: string | null;
}

export interface SubscriptionRecord {
  id: number;
  member_id: number;
  plan_id: number;
  status: string;
  shopify_subscription_contract_id: number | null;
  shopify_subscription_contract_gid: string | null;
  shopify_customer_id: number | null;
  next_billing_date: Date | null;
  current_period_start: Date | null;
  current_period_end: Date | null;
  billing_status: string;
  failed_billing_attempts: number;
  billing_in_progress: boolean;
  cancelled_at: Date | null;
  cancellation_reason: string | null;
  payment_method_id: string | null;
  revision_id: string | null;
  started_at: Date | null;
  created_at: Date;
}

export interface PlanRecord {
  id: number;
  name: string;
  tier: string;
  billing_interval: string | null;
  billing_interval_count: number;
  price_cents: number | null;
  shopify_selling_plan_gid: string | null;
  includes_dropship: boolean;
  is_active: boolean;
  priority_modifier: number;
}

export interface BillingLogRecord {
  id: number;
  member_subscription_id: number;
  shopify_billing_attempt_id: string | null;
  shopify_order_id: number | null;
  amount_cents: number;
  currency: string;
  status: string;
  error_code: string | null;
  error_message: string | null;
  idempotency_key: string | null;
  billing_period_start: Date | null;
  billing_period_end: Date | null;
  created_at: Date;
}

export interface SubscriptionEvent {
  id: number;
  member_subscription_id: number | null;
  shopify_subscription_contract_id: number | null;
  event_type: string;
  event_source: string;
  payload: any;
  notes: string | null;
  created_at: Date;
}

export interface SubscriptionDashboardStats {
  totalActive: number;
  totalActiveStandard: number;
  totalActiveGold: number;
  mrr: number; // in cents
  churnRate30: number;
  churnRate90: number;
  pastDueCount: number;
  newThisMonth: number;
  cancelledThisMonth: number;
}

export interface ShopifyGraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; locations?: any[]; path?: any[] }>;
  extensions?: { cost?: { requestedQueryCost: number; actualQueryCost: number; throttleStatus: { maximumAvailable: number; currentlyAvailable: number; restoreRate: number } } };
}
