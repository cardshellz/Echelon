import { vendorFetch } from "./vendor-auth";

// Helper to parse JSON or throw
async function parseOrThrow(res: Response) {
  if (!res.ok) {
    const text = await res.text();
    let msg = `${res.status}: ${res.statusText}`;
    try {
      const j = JSON.parse(text);
      msg = j.message || j.error || msg;
    } catch {}
    throw new Error(msg);
  }
  return res.json();
}

// Auth
export async function vendorRegister(body: {
  email: string;
  password: string;
  name: string;
  companyName?: string;
  phone?: string;
  shellzClubMemberId?: string;
}) {
  const res = await fetch("/api/vendor/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseOrThrow(res);
}

// Dashboard stats
export async function fetchVendorDashboard() {
  const [meRes, walletRes, ordersRes, productsRes] = await Promise.all([
    vendorFetch("/api/vendor/auth/me"),
    vendorFetch("/api/vendor/wallet"),
    vendorFetch("/api/vendor/orders?limit=5"),
    vendorFetch("/api/vendor/products?selected=true&limit=1"),
  ]);
  const me = await parseOrThrow(meRes);
  const wallet = await parseOrThrow(walletRes);
  const orders = await parseOrThrow(ordersRes);
  const products = await parseOrThrow(productsRes);
  return { me, wallet, orders, products };
}

// Products
export async function fetchVendorProducts(params: {
  page?: number;
  limit?: number;
  search?: string;
  selected?: string;
}) {
  const qs = new URLSearchParams();
  if (params.page) qs.set("page", String(params.page));
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.search) qs.set("search", params.search);
  if (params.selected) qs.set("selected", params.selected);
  const res = await vendorFetch(`/api/vendor/products?${qs}`);
  return parseOrThrow(res);
}

export async function selectVendorProducts(productIds: number[]) {
  const res = await vendorFetch("/api/vendor/products/select", {
    method: "POST",
    body: JSON.stringify({ productIds }),
  });
  return parseOrThrow(res);
}

export async function deselectVendorProduct(productId: number) {
  const res = await vendorFetch(`/api/vendor/products/${productId}`, {
    method: "DELETE",
  });
  return parseOrThrow(res);
}

// Orders
export async function fetchVendorOrders(params: {
  page?: number;
  limit?: number;
  status?: string;
}) {
  const qs = new URLSearchParams();
  if (params.page) qs.set("page", String(params.page));
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.status) qs.set("status", params.status);
  const res = await vendorFetch(`/api/vendor/orders?${qs}`);
  return parseOrThrow(res);
}

// Wallet
export async function fetchVendorWallet() {
  const res = await vendorFetch("/api/vendor/wallet");
  return parseOrThrow(res);
}

export async function fetchVendorLedger(params: {
  page?: number;
  limit?: number;
  type?: string;
}) {
  const qs = new URLSearchParams();
  if (params.page) qs.set("page", String(params.page));
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.type) qs.set("type", params.type);
  const res = await vendorFetch(`/api/vendor/wallet/ledger?${qs}`);
  return parseOrThrow(res);
}

export async function createWalletDeposit(amountCents: number) {
  const res = await vendorFetch("/api/vendor/wallet/deposit", {
    method: "POST",
    body: JSON.stringify({ amount_cents: amountCents }),
  });
  return parseOrThrow(res);
}

export async function updateAutoReload(body: {
  enabled?: boolean;
  threshold_cents?: number;
  amount_cents?: number;
}) {
  const res = await vendorFetch("/api/vendor/wallet/auto-reload", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return parseOrThrow(res);
}

// eBay
export async function fetchEbayStatus() {
  const res = await vendorFetch("/api/vendor/ebay/status");
  return parseOrThrow(res);
}

export async function getEbayAuthUrl() {
  const res = await vendorFetch("/api/vendor/ebay/auth-url");
  return parseOrThrow(res);
}

export async function disconnectEbay() {
  const res = await vendorFetch("/api/vendor/ebay/disconnect", { method: "POST" });
  return parseOrThrow(res);
}

export async function pushToEbay(productIds: number[]) {
  const res = await vendorFetch("/api/vendor/ebay/push", {
    method: "POST",
    body: JSON.stringify({ product_ids: productIds }),
  });
  return parseOrThrow(res);
}

export async function fetchEbayListings() {
  const res = await vendorFetch("/api/vendor/ebay/listings");
  return parseOrThrow(res);
}

// Settings / Profile
export async function updateVendorProfile(body: {
  name?: string;
  company_name?: string;
  phone?: string;
}) {
  const res = await vendorFetch("/api/vendor/auth/me", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  return parseOrThrow(res);
}

export async function changeVendorPassword(body: {
  current_password: string;
  new_password: string;
}) {
  const res = await vendorFetch("/api/vendor/auth/password", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return parseOrThrow(res);
}
