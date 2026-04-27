import React, { useState, useMemo, useEffect } from 'react';
import {
  LayoutDashboard, Package, ShoppingCart, Wallet, Settings,
  Search, Bell, ChevronRight, ChevronDown, AlertTriangle,
  CheckCircle2, Clock, ArrowUpRight, ArrowDownRight, ExternalLink,
  Plus, X, Filter, Download, Copy, Eye, EyeOff,
  Truck, RotateCcw, Key, Webhook, Globe, Unlink,
  Check, ArrowRight, CreditCard, Building2, Coins, Info,
  Hexagon, Box,
} from 'lucide-react';

// Design tokens
const PURPLE = 'rgb(192, 96, 224)';
const PURPLE_DARK = 'rgb(154, 65, 184)';
const PURPLE_TINT = 'rgba(192, 96, 224, 0.08)';
const PURPLE_TINT_2 = 'rgba(192, 96, 224, 0.14)';

// Mock data
const VENDOR = {
  name: 'Mike Castellano',
  business: 'Castellano Cards & Collectibles',
  email: 'mike@castellanocards.com',
  tier: '.ops',
  ebayStore: 'castellano-cards-co',
  memberSince: 'Jan 2026',
};

const WALLET = {
  balance: 482.51,
  minBalance: 50,
  maxReload: 500,
  pending: 17.49,
  autoReload: true,
  paymentMethod: 'ACH \u2022\u2022\u2022\u2022 4421',
};

const ALERTS = [
  { id: 1, kind: 'warn', icon: Clock, title: 'eBay token expires in 14 days', body: 'Reconnect to keep your listings synced.', cta: 'Reconnect now' },
  { id: 2, kind: 'info', icon: RotateCcw, title: '1 RMA pending inspection', body: 'Return for order DS-00138 received this morning.', cta: 'View RMA' },
];

const ORDERS = [
  { id: 'DS-00142', ref: 'EBY-9912', status: 'shipped', items: 3, total: 47.12, dest: 'Pittsburgh, PA', when: '2h ago', tracking: '9400110200881234567890', carrier: 'USPS' },
  { id: 'DS-00141', ref: 'EBY-9908', status: 'picking', items: 1, total: 12.74, dest: 'Austin, TX', when: '4h ago', tracking: null, carrier: null },
  { id: 'DS-00140', ref: 'EBY-9904', status: 'delivered', items: 2, total: 28.99, dest: 'Sacramento, CA', when: 'Yesterday', tracking: '1Z999AA10123456784', carrier: 'UPS' },
  { id: 'DS-00139', ref: 'EBY-9899', status: 'shipped', items: 5, total: 84.21, dest: 'Brooklyn, NY', when: 'Yesterday', tracking: '9400110200881234567891', carrier: 'USPS' },
  { id: 'DS-00138', ref: 'EBY-9891', status: 'returned', items: 1, total: 18.50, dest: 'Miami, FL', when: '3 days ago', tracking: '9400110200881234567892', carrier: 'USPS' },
  { id: 'DS-00137', ref: 'EBY-9887', status: 'delivered', items: 4, total: 62.40, dest: 'Seattle, WA', when: '4 days ago', tracking: '1Z999AA10123456785', carrier: 'UPS' },
  { id: 'DS-00136', ref: 'EBY-9882', status: 'delivered', items: 2, total: 24.18, dest: 'Denver, CO', when: '5 days ago', tracking: '9400110200881234567893', carrier: 'USPS' },
];

const STATUS_STYLES = {
  submitted:  { bg: '#F4F4F5', fg: '#52525B', label: 'Submitted' },
  accepted:   { bg: '#EFF6FF', fg: '#1D4ED8', label: 'Accepted' },
  picking:    { bg: '#FEF3C7', fg: '#92400E', label: 'Picking' },
  packed:     { bg: '#FEF3C7', fg: '#92400E', label: 'Packed' },
  shipped:    { bg: PURPLE_TINT_2, fg: PURPLE_DARK, label: 'Shipped' },
  delivered:  { bg: '#DCFCE7', fg: '#166534', label: 'Delivered' },
  returned:   { bg: '#FEE2E2', fg: '#991B1B', label: 'Returned' },
  cancelled:  { bg: '#F4F4F5', fg: '#52525B', label: 'Cancelled' },
  rejected:   { bg: '#FEE2E2', fg: '#991B1B', label: 'Rejected' },
  pending:    { bg: '#F4F4F5', fg: '#52525B', label: 'Pending' },
  approved:   { bg: '#DCFCE7', fg: '#166534', label: 'Approved' },
};

const CATEGORIES = [
  { id: 'all', name: 'Entire catalog', count: 247 },
  { id: 'top', name: 'Toploaders', count: 38 },
  { id: 'sleeves', name: 'Penny Sleeves', count: 22 },
  { id: 'mag', name: 'Magnetic Holders', count: 19 },
  { id: 'bcw', name: 'Card Boxes & Storage', count: 41 },
  { id: 'arm', name: 'Armalopes', count: 14 },
  { id: 'binders', name: 'Binders & Pages', count: 33 },
  { id: 'graded', name: 'Graded Card Supplies', count: 28 },
  { id: 'wax', name: 'Wax & Display', count: 17 },
  { id: 'misc', name: 'Misc Supplies', count: 35 },
];

const PRODUCTS = [
  { sku: 'CS-TL-35PT-25', name: 'Premium UV Toploaders 35pt', cat: 'top', wholesale: 9.74, msrp: 12.99, atp: 1247, weight: '0.4 lb', selected: true, listed: true, retail: 14.99 },
  { sku: 'CS-TL-55PT-25', name: 'Premium UV Toploaders 55pt', cat: 'top', wholesale: 11.24, msrp: 14.99, atp: 892, weight: '0.5 lb', selected: true, listed: true, retail: 17.49 },
  { sku: 'CS-TL-75PT-25', name: 'Premium UV Toploaders 75pt', cat: 'top', wholesale: 13.49, msrp: 17.99, atp: 421, weight: '0.7 lb', selected: true, listed: true, retail: 20.99 },
  { sku: 'CS-TL-100PT-25', name: 'Premium UV Toploaders 100pt', cat: 'top', wholesale: 14.99, msrp: 19.99, atp: 312, weight: '0.9 lb', selected: false, listed: false, retail: null },
  { sku: 'CS-PS-STD-100', name: 'Standard Penny Sleeves 100ct', cat: 'sleeves', wholesale: 2.62, msrp: 3.49, atp: 4821, weight: '0.2 lb', selected: true, listed: true, retail: 4.49 },
  { sku: 'CS-PS-PERF-100', name: 'Perfect Fit Sleeves 100ct', cat: 'sleeves', wholesale: 3.74, msrp: 4.99, atp: 2104, weight: '0.2 lb', selected: true, listed: true, retail: 5.99 },
  { sku: 'CS-MAG-35PT-1', name: 'Magnetic Card Holder 35pt', cat: 'mag', wholesale: 1.87, msrp: 2.49, atp: 1893, weight: '0.1 lb', selected: true, listed: true, retail: 3.49 },
  { sku: 'CS-MAG-55PT-1', name: 'Magnetic Card Holder 55pt', cat: 'mag', wholesale: 2.24, msrp: 2.99, atp: 1421, weight: '0.1 lb', selected: false, listed: false, retail: null },
  { sku: 'CS-ARM-CASE-100', name: 'Armalope Case (100ct)', cat: 'arm', wholesale: 89.99, msrp: 119.99, atp: 47, weight: '18 lb', selected: false, listed: false, retail: null },
  { sku: 'CS-BCW-200', name: 'BCW 200ct Storage Box', cat: 'bcw', wholesale: 1.42, msrp: 1.99, atp: 3214, weight: '0.5 lb', selected: true, listed: true, retail: 2.99 },
];

function Tag({ status }) {
  const s = STATUS_STYLES[status] || STATUS_STYLES.pending;
  return (
    <span style={{ background: s.bg, color: s.fg }} className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium tracking-wide">
      {s.label}
    </span>
  );
}

function Card({ children, className = '', ...props }) {
  return (
    <div
      {...props}
      className={`bg-white rounded-2xl border border-zinc-200 ${className}`}
      style={{ boxShadow: '0 1px 2px rgba(15, 15, 20, 0.04)' }}
    >
      {children}
    </div>
  );
}

function Btn({ variant = 'primary', size = 'md', children, className = '', ...props }) {
  const sz = size === 'sm' ? 'px-3 py-1.5 text-xs' : size === 'lg' ? 'px-5 py-3 text-sm' : 'px-4 py-2 text-sm';
  const base = `inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-all ${sz}`;
  if (variant === 'primary') {
    return (
      <button {...props} className={`${base} text-white hover:opacity-90 ${className}`} style={{ background: PURPLE }}>
        {children}
      </button>
    );
  }
  if (variant === 'danger') {
    return <button {...props} className={`${base} text-red-700 bg-red-50 hover:bg-red-100 ${className}`}>{children}</button>;
  }
  if (variant === 'ghost') {
    return <button {...props} className={`${base} text-zinc-700 hover:bg-zinc-100 ${className}`}>{children}</button>;
  }
  return <button {...props} className={`${base} bg-white text-zinc-900 border border-zinc-200 hover:bg-zinc-50 ${className}`}>{children}</button>;
}

function Sidebar({ active, onNavigate }) {
  const items = [
    { k: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { k: 'catalog', label: 'Catalog', icon: Package },
    { k: 'orders', label: 'Orders', icon: ShoppingCart, badge: 1 },
    { k: 'wallet', label: 'Wallet', icon: Wallet },
    { k: 'returns', label: 'Returns', icon: RotateCcw, badge: 1 },
    { k: 'settings', label: 'Settings', icon: Settings },
  ];

  return (
    <aside className="w-56 shrink-0 bg-white border-r border-zinc-200 flex flex-col" style={{ minHeight: '100vh' }}>
      <div className="px-5 pt-6 pb-5">
        <button onClick={() => onNavigate('dashboard')} className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: '#0A0A0A' }}>
            <Hexagon className="w-4 h-4" style={{ color: PURPLE }} strokeWidth={2.5} />
          </div>
          <div className="text-sm font-semibold tracking-tight text-zinc-900">.ops</div>
        </button>
      </div>

      <nav className="px-3 flex-1">
        {items.map(it => {
          const Icon = it.icon;
          const isActive = active === it.k;
          return (
            <button
              key={it.k}
              onClick={() => onNavigate(it.k)}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium mb-0.5 transition-colors"
              style={{
                color: isActive ? PURPLE_DARK : '#3F3F46',
                background: isActive ? PURPLE_TINT : 'transparent',
              }}
            >
              <Icon className="w-4 h-4" strokeWidth={2} />
              <span className="flex-1 text-left">{it.label}</span>
              {it.badge && (
                <span className="text-xs font-semibold px-1.5 py-0.5 rounded-full text-white" style={{ background: PURPLE }}>{it.badge}</span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="p-3 border-t border-zinc-100">
        <button onClick={() => onNavigate('settings')} className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-zinc-50">
          <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold text-white" style={{ background: PURPLE }}>
            MC
          </div>
          <div className="flex-1 text-left min-w-0">
            <div className="text-sm font-semibold text-zinc-900 truncate">{VENDOR.business}</div>
            <div className="text-xs text-zinc-500 truncate">.ops member</div>
          </div>
          <ChevronRight className="w-4 h-4 text-zinc-400" />
        </button>
      </div>
    </aside>
  );
}

function Topbar({ title, subtitle, right }) {
  return (
    <div className="flex items-end justify-between mb-7 gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900" style={{ fontFamily: '"Inter Tight", Inter, -apple-system, sans-serif', letterSpacing: '-0.01em' }}>{title}</h1>
        {subtitle && <p className="text-sm text-zinc-500 mt-1">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-2 shrink-0">{right}</div>
    </div>
  );
}

function Row({ label, value, mono, warn }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-zinc-500">{label}</span>
      <span className={`${mono ? 'font-mono text-xs' : ''} ${warn ? 'text-amber-700 font-medium' : 'text-zinc-900'}`}>{value}</span>
    </div>
  );
}

function KPI({ label, value, sub, trend, ok }) {
  return (
    <Card className="p-4">
      <div className="text-xs font-medium uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <div className="text-2xl font-semibold tracking-tight text-zinc-900 tabular-nums">{value}</div>
        {trend != null && (
          <span className={`inline-flex items-center text-xs font-medium ${trend >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
            {trend >= 0 ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
            {Math.abs(trend)}%
          </span>
        )}
        {ok && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />}
      </div>
      <div className="text-xs text-zinc-500 mt-1">{sub}</div>
    </Card>
  );
}

function Dashboard({ onNavigate }) {
  return (
    <div>
      <Topbar
        title={`Good afternoon, ${VENDOR.name.split(' ')[0]}`}
        subtitle="Here's what's happening with your shop today."
        right={
          <>
            <Btn variant="secondary" size="sm"><Bell className="w-4 h-4" />Notifications</Btn>
            <Btn variant="primary" size="sm" onClick={() => onNavigate('catalog')}><Plus className="w-4 h-4" />Add products</Btn>
          </>
        }
      />

      <div className="space-y-2 mb-7">
        {ALERTS.map(a => {
          const Icon = a.icon;
          const ring = a.kind === 'warn' ? 'border-amber-200 bg-amber-50' : 'border-zinc-200 bg-white';
          const iconColor = a.kind === 'warn' ? '#B45309' : PURPLE_DARK;
          return (
            <div key={a.id} className={`flex items-center gap-3 px-4 py-3 rounded-xl border ${ring}`}>
              <Icon className="w-4 h-4 shrink-0" style={{ color: iconColor }} strokeWidth={2} />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-zinc-900">{a.title}</div>
                <div className="text-xs text-zinc-600">{a.body}</div>
              </div>
              <Btn variant="secondary" size="sm">{a.cta} <ArrowRight className="w-3 h-3" /></Btn>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-4 gap-3 mb-7">
        <KPI label="Wallet balance" value={`$${WALLET.balance.toFixed(2)}`} sub={`Auto-reload at $${WALLET.minBalance}`} />
        <KPI label="Orders today" value="14" sub="3 shipped, 11 in queue" trend={12} />
        <KPI label="This month revenue" value="$3,847" sub="From 218 orders" trend={8} />
        <KPI label="Avg ship time" value="0.8 days" sub="SLA: 1 business day" ok />
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Card className="col-span-2 p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="text-base font-semibold tracking-tight text-zinc-900">Recent orders</div>
              <div className="text-xs text-zinc-500 mt-0.5">Last 7 days</div>
            </div>
            <button onClick={() => onNavigate('orders')} className="text-xs font-medium hover:underline" style={{ color: PURPLE_DARK }}>
              View all \u2192
            </button>
          </div>
          <div className="space-y-1">
            {ORDERS.slice(0, 5).map(o => (
              <button
                key={o.id}
                onClick={() => onNavigate('orders')}
                className="w-full flex items-center gap-3 px-2 py-2.5 rounded-lg hover:bg-zinc-50 text-left"
              >
                <div className="w-8 h-8 rounded-lg bg-zinc-100 flex items-center justify-center shrink-0">
                  <Truck className="w-4 h-4 text-zinc-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="text-xs font-semibold text-zinc-900 font-mono">{o.id}</div>
                    <Tag status={o.status} />
                  </div>
                  <div className="text-xs text-zinc-500 mt-0.5 truncate">{o.items} {o.items === 1 ? 'item' : 'items'} \u00b7 to {o.dest} \u00b7 {o.when}</div>
                </div>
                <div className="text-sm font-semibold text-zinc-900 tabular-nums">${o.total.toFixed(2)}</div>
              </button>
            ))}
          </div>
        </Card>

        <Card className="p-5">
          <div className="text-base font-semibold tracking-tight text-zinc-900 mb-4">Top SKUs this month</div>
          <div className="space-y-3">
            {[
              { sku: 'CS-PS-STD-100', name: 'Penny Sleeves 100ct', sold: 89, rev: '$311.50' },
              { sku: 'CS-TL-35PT-25', name: 'UV Toploaders 35pt', sold: 47, rev: '$457.78' },
              { sku: 'CS-MAG-35PT-1', name: 'Mag Holder 35pt', sold: 32, rev: '$59.84' },
              { sku: 'CS-TL-55PT-25', name: 'UV Toploaders 55pt', sold: 28, rev: '$314.72' },
            ].map((r, i) => (
              <div key={i}>
                <div className="flex items-baseline justify-between mb-1">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-zinc-900 truncate">{r.name}</div>
                    <div className="text-xs font-mono text-zinc-400">{r.sku}</div>
                  </div>
                  <div className="text-xs font-semibold tabular-nums text-zinc-900">{r.rev}</div>
                </div>
                <div className="h-1 bg-zinc-100 rounded-full overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${(r.sold / 89) * 100}%`, background: PURPLE }} />
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-4 mt-4">
        <Card className="p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="text-base font-semibold tracking-tight text-zinc-900">eBay sync status</div>
            <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> Connected
            </span>
          </div>
          <div className="space-y-2 text-sm">
            <Row label="Active listings" value="38 of 247 catalog SKUs" />
            <Row label="Last sync" value="3 minutes ago" />
            <Row label="Token expires" value="14 days" warn />
            <Row label="Store" value={VENDOR.ebayStore} mono />
          </div>
        </Card>

        <Card className="p-5">
          <div className="text-base font-semibold tracking-tight text-zinc-900 mb-3">Wallet activity</div>
          <div className="space-y-2 text-sm">
            <Row label="Auto-reload" value={`$${WALLET.minBalance} threshold`} />
            <Row label="Pending charges" value={`$${WALLET.pending.toFixed(2)}`} />
            <Row label="Last reload" value="$200.00 \u00b7 2 days ago" />
            <Row label="Method on file" value="ACH (Plaid verified)" />
          </div>
        </Card>
      </div>
    </div>
  );
}

function Catalog() {
  const [activeCat, setActiveCat] = useState('all');
  const [selected, setSelected] = useState(
    Object.fromEntries(PRODUCTS.map(p => [p.sku, p.selected]))
  );
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    return PRODUCTS.filter(p => {
      if (activeCat !== 'all' && p.cat !== activeCat) return false;
      if (query && !p.name.toLowerCase().includes(query.toLowerCase()) && !p.sku.toLowerCase().includes(query.toLowerCase())) return false;
      return true;
    });
  }, [activeCat, query]);

  const totalSelected = Object.values(selected).filter(Boolean).length;

  return (
    <div>
      <Topbar
        title="Catalog"
        subtitle="Pick what to push to your eBay store. Select the entire catalog, a category, or individual SKUs."
        right={
          <>
            <Btn variant="secondary" size="sm"><Filter className="w-4 h-4" />Filter</Btn>
            <Btn variant="primary" size="sm">Push {totalSelected} to eBay <ArrowRight className="w-4 h-4" /></Btn>
          </>
        }
      />

      <div className="grid gap-5" style={{ gridTemplateColumns: '220px 1fr' }}>
        <div>
          <Card className="p-2">
            {CATEGORIES.map(c => (
              <button
                key={c.id}
                onClick={() => setActiveCat(c.id)}
                className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-left text-sm font-medium transition-colors"
                style={{
                  color: activeCat === c.id ? PURPLE_DARK : '#3F3F46',
                  background: activeCat === c.id ? PURPLE_TINT : 'transparent',
                }}
              >
                <span>{c.name}</span>
                <span className="text-xs text-zinc-400 tabular-nums">{c.count}</span>
              </button>
            ))}
          </Card>

          <Card className="p-4 mt-3">
            <div className="flex items-center gap-2 mb-2">
              <Info className="w-3.5 h-3.5 text-zinc-400" />
              <div className="text-xs font-semibold text-zinc-700">Bulk action</div>
            </div>
            <div className="text-xs text-zinc-500 leading-relaxed mb-3">
              Selecting at the catalog or category level subscribes you. New products in that scope auto-list to your eBay.
            </div>
            <Btn variant="secondary" size="sm" className="w-full">Subscribe to category</Btn>
          </Card>
        </div>

        <div>
          <div className="relative mb-3">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search by name or SKU"
              className="w-full pl-9 pr-3 py-2 text-sm bg-white border border-zinc-200 rounded-lg focus:outline-none focus:border-zinc-400"
            />
          </div>

          <Card className="overflow-hidden">
            <div className="grid gap-3 px-4 py-2.5 bg-zinc-50 border-b border-zinc-100 text-xs font-semibold uppercase tracking-wider text-zinc-500" style={{ gridTemplateColumns: '36px 1fr 110px 90px 90px 110px' }}>
              <div></div>
              <div>Product</div>
              <div className="text-right">Wholesale</div>
              <div className="text-right">MSRP</div>
              <div className="text-right">ATP</div>
              <div className="text-right">Your retail</div>
            </div>
            {filtered.map(p => {
              const isSel = selected[p.sku];
              return (
                <div key={p.sku} className="grid gap-3 px-4 py-3 border-b border-zinc-100 items-center hover:bg-zinc-50" style={{ gridTemplateColumns: '36px 1fr 110px 90px 90px 110px' }}>
                  <button
                    onClick={() => setSelected(s => ({ ...s, [p.sku]: !s[p.sku] }))}
                    className="w-5 h-5 rounded-md border-2 flex items-center justify-center transition-colors"
                    style={{
                      borderColor: isSel ? PURPLE : '#D4D4D8',
                      background: isSel ? PURPLE : 'white',
                    }}
                  >
                    {isSel && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
                  </button>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-zinc-900 truncate">{p.name}</div>
                    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                      <span className="text-xs font-mono text-zinc-400">{p.sku}</span>
                      <span className="text-xs text-zinc-400">\u00b7</span>
                      <span className="text-xs text-zinc-500">{p.weight}</span>
                      {p.listed && (
                        <>
                          <span className="text-xs text-zinc-400">\u00b7</span>
                          <span className="inline-flex items-center gap-1 text-xs font-medium" style={{ color: PURPLE_DARK }}>
                            <span className="w-1.5 h-1.5 rounded-full" style={{ background: PURPLE }} />
                            Live on eBay
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="text-right text-sm font-semibold text-zinc-900 tabular-nums">${p.wholesale.toFixed(2)}</div>
                  <div className="text-right text-sm text-zinc-500 tabular-nums">${p.msrp.toFixed(2)}</div>
                  <div className="text-right text-sm tabular-nums">
                    <span className={p.atp < 100 ? 'text-amber-700 font-medium' : 'text-zinc-700'}>{p.atp.toLocaleString()}</span>
                  </div>
                  <div className="text-right">
                    {isSel ? (
                      <input
                        type="text"
                        defaultValue={p.retail ? `$${p.retail.toFixed(2)}` : `$${(p.msrp * 1.15).toFixed(2)}`}
                        className="w-full text-right text-sm font-semibold tabular-nums px-2 py-1 bg-white border border-zinc-200 rounded-md focus:outline-none focus:border-zinc-400"
                      />
                    ) : (
                      <span className="text-xs text-zinc-300">\u2014</span>
                    )}
                  </div>
                </div>
              );
            })}
          </Card>

          <div className="flex items-center justify-between mt-3 px-1">
            <div className="text-xs text-zinc-500">
              <span className="font-semibold text-zinc-900">{totalSelected}</span> products selected to push to eBay
            </div>
            <div className="text-xs text-zinc-500">{filtered.length} of {PRODUCTS.length} shown</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function OrderDetail({ order }) {
  return (
    <div className="bg-zinc-50 px-5 py-5 border-b border-zinc-100">
      <div className="grid grid-cols-3 gap-5">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">Ship to</div>
          <div className="text-sm font-medium text-zinc-900">Sarah Mitchell</div>
          <div className="text-xs text-zinc-600 mt-0.5 leading-relaxed">
            1428 Elm Street<br />
            Apt 3B<br />
            {order.dest} 15206<br />
            (412) 555-0142
          </div>
        </div>

        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">Items</div>
          <div className="space-y-1.5 text-xs">
            <div className="flex justify-between gap-2">
              <span className="text-zinc-700">2\u00d7 Premium UV Toploaders 35pt</span>
              <span className="font-mono tabular-nums text-zinc-900">$19.48</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-zinc-700">1\u00d7 Penny Sleeves 100ct</span>
              <span className="font-mono tabular-nums text-zinc-900">$2.62</span>
            </div>
          </div>
        </div>

        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">Wallet debit</div>
          <div className="space-y-1 text-xs">
            <div className="flex justify-between gap-2"><span className="text-zinc-600">Wholesale</span><span className="font-mono tabular-nums text-zinc-900">$22.10</span></div>
            <div className="flex justify-between gap-2"><span className="text-zinc-600">Shipping (1 pkg)</span><span className="font-mono tabular-nums text-zinc-900">${(order.total - 22.10).toFixed(2)}</span></div>
            <div className="flex justify-between gap-2 pt-1.5 mt-1.5 border-t border-zinc-200 font-semibold"><span className="text-zinc-900">Total charged</span><span className="font-mono tabular-nums text-zinc-900">${order.total.toFixed(2)}</span></div>
          </div>
        </div>
      </div>

      {order.tracking && (
        <div className="mt-5 pt-5 border-t border-zinc-200">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="min-w-0">
              <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1">Tracking</div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-mono text-zinc-900">{order.tracking}</span>
                <span className="text-xs text-zinc-500">\u00b7 {order.carrier} \u00b7 USPS First Class</span>
                <button className="text-zinc-400 hover:text-zinc-600"><Copy className="w-3.5 h-3.5" /></button>
              </div>
            </div>
            <Btn variant="secondary" size="sm">Track package <ExternalLink className="w-3 h-3" /></Btn>
          </div>
        </div>
      )}
    </div>
  );
}

function Orders() {
  const [filter, setFilter] = useState('all');
  const [openOrder, setOpenOrder] = useState(null);

  const filtered = ORDERS.filter(o => filter === 'all' || o.status === filter);

  return (
    <div>
      <Topbar
        title="Orders"
        subtitle="Every order from your eBay store, synced in real time."
        right={
          <>
            <Btn variant="secondary" size="sm"><Download className="w-4 h-4" />Export</Btn>
            <Btn variant="secondary" size="sm"><Filter className="w-4 h-4" />Filter</Btn>
          </>
        }
      />

      <div className="flex items-center gap-1 mb-4 border-b border-zinc-200 overflow-x-auto">
        {[
          { k: 'all', label: 'All', count: ORDERS.length },
          { k: 'picking', label: 'Picking', count: ORDERS.filter(o => o.status === 'picking').length },
          { k: 'shipped', label: 'Shipped', count: ORDERS.filter(o => o.status === 'shipped').length },
          { k: 'delivered', label: 'Delivered', count: ORDERS.filter(o => o.status === 'delivered').length },
          { k: 'returned', label: 'Returned', count: ORDERS.filter(o => o.status === 'returned').length },
        ].map(t => (
          <button
            key={t.k}
            onClick={() => setFilter(t.k)}
            className="px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px whitespace-nowrap"
            style={{
              color: filter === t.k ? PURPLE_DARK : '#71717A',
              borderColor: filter === t.k ? PURPLE : 'transparent',
            }}
          >
            {t.label} <span className="text-zinc-400 ml-1 tabular-nums">{t.count}</span>
          </button>
        ))}
      </div>

      <Card className="overflow-hidden">
        <div className="grid gap-3 px-5 py-3 bg-zinc-50 border-b border-zinc-100 text-xs font-semibold uppercase tracking-wider text-zinc-500" style={{ gridTemplateColumns: '110px 100px 1fr 130px 90px 90px 24px' }}>
          <div>Order ID</div>
          <div>eBay ref</div>
          <div>Destination</div>
          <div>Status</div>
          <div className="text-right">Total</div>
          <div className="text-right">When</div>
          <div></div>
        </div>
        {filtered.map(o => (
          <React.Fragment key={o.id}>
            <button
              onClick={() => setOpenOrder(openOrder === o.id ? null : o.id)}
              className="w-full grid gap-3 px-5 py-3.5 border-b border-zinc-100 items-center hover:bg-zinc-50 text-left"
              style={{ gridTemplateColumns: '110px 100px 1fr 130px 90px 90px 24px' }}
            >
              <div className="text-xs font-mono font-semibold text-zinc-900">{o.id}</div>
              <div className="text-xs font-mono text-zinc-500">{o.ref}</div>
              <div className="text-sm text-zinc-700 truncate">{o.dest} \u00b7 {o.items} {o.items === 1 ? 'item' : 'items'}</div>
              <div><Tag status={o.status} /></div>
              <div className="text-right text-sm font-semibold text-zinc-900 tabular-nums">${o.total.toFixed(2)}</div>
              <div className="text-right text-xs text-zinc-500">{o.when}</div>
              <ChevronDown className={`w-4 h-4 text-zinc-400 transition-transform ${openOrder === o.id ? 'rotate-180' : ''}`} />
            </button>
            {openOrder === o.id && <OrderDetail order={o} />}
          </React.Fragment>
        ))}
      </Card>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="text-sm font-semibold text-zinc-900 mt-1 tabular-nums">{value}</div>
    </div>
  );
}

function FundingMethod({ icon: Icon, title, sub, badge, comingSoon }) {
  return (
    <div className="flex items-center gap-3 px-3 py-3 border border-zinc-200 rounded-lg mb-2 last:mb-0">
      <div className="w-9 h-9 rounded-lg bg-zinc-100 flex items-center justify-center shrink-0">
        <Icon className="w-4 h-4 text-zinc-600" strokeWidth={2} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="text-sm font-semibold text-zinc-900 truncate">{title}</div>
          {badge && (
            <span className="text-xs font-semibold px-1.5 py-0.5 rounded text-white" style={{ background: PURPLE }}>{badge}</span>
          )}
          {comingSoon && (
            <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-600">Coming Phase 2</span>
          )}
        </div>
        <div className="text-xs text-zinc-500 mt-0.5">{sub}</div>
      </div>
    </div>
  );
}

function FundingModal({ onClose }) {
  const [amount, setAmount] = useState(200);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ background: 'rgba(24,24,27,0.4)' }}>
      <Card className="w-full max-w-md p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-5">
          <div className="text-lg font-semibold tracking-tight text-zinc-900">Add funds</div>
          <button onClick={onClose} className="w-7 h-7 rounded-lg hover:bg-zinc-100 flex items-center justify-center"><X className="w-4 h-4" /></button>
        </div>

        <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">Amount</div>
        <div className="flex items-center gap-1.5 mb-4 flex-wrap">
          {[50, 100, 200, 500, 1000].map(v => (
            <button
              key={v}
              onClick={() => setAmount(v)}
              className="px-3 py-2 rounded-lg text-sm font-medium border transition-all"
              style={{
                borderColor: amount === v ? PURPLE : '#E4E4E7',
                background: amount === v ? PURPLE_TINT : 'white',
                color: amount === v ? PURPLE_DARK : '#3F3F46',
              }}
            >
              ${v}
            </button>
          ))}
        </div>

        <div className="relative mb-4">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-zinc-500">$</span>
          <input
            type="number"
            value={amount}
            onChange={e => setAmount(Number(e.target.value))}
            className="w-full pl-7 pr-3 py-2.5 text-sm font-semibold border border-zinc-200 rounded-lg focus:outline-none focus:border-zinc-400"
          />
        </div>

        <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">From</div>
        <div className="space-y-1.5 mb-5">
          {[
            { id: 'ach', icon: Building2, label: 'ACH', sub: 'Wells Fargo \u2022\u2022\u2022\u2022 4421', fee: 'No fee \u00b7 1-2 day clearing' },
            { id: 'card', icon: CreditCard, label: 'Visa \u2022\u2022\u2022\u2022 8821', sub: 'Instant', fee: '~3% processing fee' },
          ].map(m => {
            const Icon = m.icon;
            return (
              <label key={m.id} className="flex items-center gap-3 px-3 py-2.5 border border-zinc-200 rounded-lg cursor-pointer hover:border-zinc-300">
                <input type="radio" name="src" defaultChecked={m.id === 'ach'} />
                <Icon className="w-4 h-4 text-zinc-500" />
                <div className="flex-1">
                  <div className="text-sm font-semibold text-zinc-900">{m.label} \u00b7 {m.sub}</div>
                  <div className="text-xs text-zinc-500">{m.fee}</div>
                </div>
              </label>
            );
          })}
        </div>

        <Btn variant="primary" size="lg" className="w-full" onClick={onClose}>
          Add ${amount.toFixed(2)} to wallet
        </Btn>
        <div className="text-xs text-zinc-500 text-center mt-3">
          Funds are locked to .ops fulfillment. Withdrawable on account closure.
        </div>
      </Card>
    </div>
  );
}

function WalletPage() {
  const [showFunding, setShowFunding] = useState(false);

  return (
    <div>
      <Topbar
        title="Wallet"
        subtitle="Pay-as-you-go funding for your dropship orders."
        right={
          <>
            <Btn variant="secondary" size="sm"><Download className="w-4 h-4" />Statement</Btn>
            <Btn variant="primary" size="sm" onClick={() => setShowFunding(true)}><Plus className="w-4 h-4" />Add funds</Btn>
          </>
        }
      />

      <div className="grid gap-4 mb-4" style={{ gridTemplateColumns: '1.4fr 1fr' }}>
        <Card className="p-6 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-64 h-64 rounded-full opacity-50 blur-3xl pointer-events-none" style={{ background: PURPLE_TINT_2, transform: 'translate(30%, -30%)' }} />
          <div className="relative">
            <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Available balance</div>
            <div className="mt-2 flex items-baseline gap-3 flex-wrap">
              <div className="text-4xl font-semibold tracking-tight text-zinc-900 tabular-nums" style={{ fontFamily: '"Inter Tight", Inter, -apple-system, sans-serif' }}>
                ${WALLET.balance.toFixed(2)}
              </div>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium" style={{ background: PURPLE_TINT, color: PURPLE_DARK }}>
                <CheckCircle2 className="w-3 h-3" /> Auto-reload on
              </span>
            </div>
            <div className="text-xs text-zinc-500 mt-1.5">
              ${WALLET.pending.toFixed(2)} pending \u00b7 Last reloaded 2 days ago
            </div>

            <div className="mt-6 pt-5 border-t border-zinc-100 grid grid-cols-3 gap-4">
              <Stat label="Min balance" value={`$${WALLET.minBalance}`} />
              <Stat label="Max single reload" value={`$${WALLET.maxReload}`} />
              <Stat label="Method" value={WALLET.paymentMethod} />
            </div>
          </div>
        </Card>

        <Card className="p-5">
          <div className="text-base font-semibold tracking-tight text-zinc-900 mb-1">Funding methods</div>
          <div className="text-xs text-zinc-500 mb-4">At least one must be on file. Auto-reload uses the default.</div>

          <FundingMethod icon={Building2} title="ACH (Plaid verified)" sub="Wells Fargo \u2022\u2022\u2022\u2022 4421" badge="Default" />
          <FundingMethod icon={CreditCard} title="Visa \u2022\u2022\u2022\u2022 8821" sub="Expires 09/2028" />
          <FundingMethod icon={Coins} title="USDC on Base" sub="Allowance: $1,000" comingSoon />

          <button className="w-full mt-2 px-3 py-2 rounded-lg border border-dashed border-zinc-300 text-xs text-zinc-600 hover:border-zinc-400 hover:bg-zinc-50">
            + Add funding method
          </button>
        </Card>
      </div>

      <Card className="p-5">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <div className="text-base font-semibold tracking-tight text-zinc-900">Transactions</div>
          <div className="flex gap-2">
            <Btn variant="ghost" size="sm">All</Btn>
            <Btn variant="ghost" size="sm">Debits</Btn>
            <Btn variant="ghost" size="sm">Reloads</Btn>
            <Btn variant="ghost" size="sm">Refunds</Btn>
          </div>
        </div>

        <div className="grid gap-3 px-2 py-2 border-b border-zinc-100 text-xs font-semibold uppercase tracking-wider text-zinc-500" style={{ gridTemplateColumns: '110px 1fr 110px 110px 110px' }}>
          <div>Date</div>
          <div>Description</div>
          <div className="text-right">Order</div>
          <div className="text-right">Amount</div>
          <div className="text-right">Balance</div>
        </div>
        {[
          { date: 'Today, 2:14 PM', desc: 'Order debit \u00b7 3 items to Pittsburgh, PA', order: 'DS-00142', amt: -47.12, bal: 482.51 },
          { date: 'Today, 12:08 PM', desc: 'Order debit \u00b7 1 item to Austin, TX', order: 'DS-00141', amt: -12.74, bal: 529.63 },
          { date: 'Today, 11:42 AM', desc: 'Auto-reload \u00b7 ACH', order: '\u2014', amt: 200.00, bal: 542.37 },
          { date: 'Yesterday', desc: 'Order debit \u00b7 2 items to Sacramento, CA', order: 'DS-00140', amt: -28.99, bal: 342.37 },
          { date: 'Yesterday', desc: 'Order debit \u00b7 5 items to Brooklyn, NY', order: 'DS-00139', amt: -84.21, bal: 371.36 },
          { date: '3 days ago', desc: 'Refund credit \u00b7 DS-00138 inspection complete', order: 'DS-00138', amt: 15.50, bal: 455.57 },
          { date: '5 days ago', desc: 'Order debit \u00b7 4 items to Seattle, WA', order: 'DS-00137', amt: -62.40, bal: 440.07 },
        ].map((t, i) => (
          <div key={i} className="grid gap-3 px-2 py-3 border-b border-zinc-100 items-center text-sm" style={{ gridTemplateColumns: '110px 1fr 110px 110px 110px' }}>
            <div className="text-zinc-500 text-xs">{t.date}</div>
            <div className="text-zinc-700 truncate">{t.desc}</div>
            <div className="text-right font-mono text-xs text-zinc-500">{t.order}</div>
            <div className={`text-right font-semibold tabular-nums ${t.amt > 0 ? 'text-emerald-700' : 'text-zinc-900'}`}>
              {t.amt > 0 ? '+' : ''}{t.amt.toFixed(2)}
            </div>
            <div className="text-right text-zinc-700 tabular-nums">${t.bal.toFixed(2)}</div>
          </div>
        ))}
      </Card>

      {showFunding && <FundingModal onClose={() => setShowFunding(false)} />}
    </div>
  );
}

function Returns() {
  return (
    <div>
      <Topbar
        title="Returns"
        subtitle="Submit RMAs and track inspection status. Returns ship to the Card Shellz warehouse."
        right={<Btn variant="primary" size="sm"><Plus className="w-4 h-4" />New RMA</Btn>}
      />

      <Card className="p-5 mb-4">
        <div className="flex items-start gap-4">
          <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center shrink-0">
            <Clock className="w-5 h-5 text-amber-700" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-zinc-900">RMA-0042 \u00b7 DS-00138 \u00b7 Pending inspection</div>
            <div className="text-xs text-zinc-500 mt-0.5">Return received this morning. Inspection typically completes within 2 business days.</div>
            <div className="flex items-center gap-4 mt-3 text-xs flex-wrap">
              <span className="text-zinc-500">Customer: Sarah Mitchell</span>
              <span className="text-zinc-500">Reason: Damaged in transit</span>
              <span className="text-zinc-500">Items: 1\u00d7 UV Toploaders 35pt</span>
              <span className="font-medium" style={{ color: PURPLE_DARK }}>Expected credit: $9.74</span>
            </div>
          </div>
          <Btn variant="secondary" size="sm">Details</Btn>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="grid gap-3 px-5 py-3 bg-zinc-50 border-b border-zinc-100 text-xs font-semibold uppercase tracking-wider text-zinc-500" style={{ gridTemplateColumns: '110px 110px 1fr 130px 110px 24px' }}>
          <div>RMA</div>
          <div>Order</div>
          <div>Reason</div>
          <div>Status</div>
          <div className="text-right">Credit</div>
          <div></div>
        </div>
        {[
          { rma: 'RMA-0042', order: 'DS-00138', reason: 'Damaged in transit', status: 'pending', credit: 9.74 },
          { rma: 'RMA-0041', order: 'DS-00131', reason: 'Customer changed mind', status: 'approved', credit: 6.74 },
          { rma: 'RMA-0040', order: 'DS-00128', reason: 'Wrong item shipped', status: 'approved', credit: 14.99 },
          { rma: 'RMA-0039', order: 'DS-00121', reason: 'Customer changed mind', status: 'rejected', credit: 0 },
        ].map(r => (
          <div key={r.rma} className="grid gap-3 px-5 py-3.5 border-b border-zinc-100 items-center hover:bg-zinc-50" style={{ gridTemplateColumns: '110px 110px 1fr 130px 110px 24px' }}>
            <div className="text-xs font-mono font-semibold text-zinc-900">{r.rma}</div>
            <div className="text-xs font-mono text-zinc-500">{r.order}</div>
            <div className="text-sm text-zinc-700 truncate">{r.reason}</div>
            <div><Tag status={r.status} /></div>
            <div className="text-right text-sm font-semibold tabular-nums" style={{ color: r.credit > 0 ? '#15803D' : '#A1A1AA' }}>
              {r.credit > 0 ? `+$${r.credit.toFixed(2)}` : '\u2014'}
            </div>
            <ChevronRight className="w-4 h-4 text-zinc-400" />
          </div>
        ))}
      </Card>
    </div>
  );
}

function Field({ label, value, mono, warn, badge, sub }) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1">{label}</div>
      <div className="flex items-center gap-2">
        {badge ? (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold" style={{ background: PURPLE_TINT_2, color: PURPLE_DARK }}>{value}</span>
        ) : (
          <div className={`text-sm ${mono ? 'font-mono text-xs' : ''} ${warn ? 'text-amber-700 font-medium' : 'text-zinc-900'}`}>{value}</div>
        )}
      </div>
      {sub && <div className="text-xs text-zinc-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function Toggle({ defaultOn, disabled }) {
  const [on, setOn] = useState(!!defaultOn);
  return (
    <button
      disabled={disabled}
      onClick={() => !disabled && setOn(!on)}
      className="relative w-9 h-5 rounded-full transition-colors disabled:opacity-60"
      style={{ background: on ? PURPLE : '#E4E4E7' }}
    >
      <span className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform" style={{ transform: on ? 'translateX(16px)' : 'translateX(0)', boxShadow: '0 1px 2px rgba(0,0,0,0.1)' }} />
    </button>
  );
}

function SettingsAccount() {
  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="text-base font-semibold tracking-tight text-zinc-900 mb-1">Profile</div>
        <div className="text-xs text-zinc-500 mb-4">Authentication is managed on cardshellz.com.</div>

        <Field label="Business name" value={VENDOR.business} />
        <Field label="Contact name" value={VENDOR.name} />
        <Field label="Email" value={VENDOR.email} sub="Sign in via cardshellz.com SSO" />
        <Field label=".ops member since" value={VENDOR.memberSince} />
        <Field label="Membership tier" value=".ops" badge />
      </Card>

      <Card className="p-5">
        <div className="text-base font-semibold tracking-tight text-zinc-900 mb-3">Active sessions</div>
        <div className="flex items-center gap-3 px-3 py-3 border border-zinc-200 rounded-lg">
          <div className="w-9 h-9 rounded-lg bg-zinc-100 flex items-center justify-center"><Globe className="w-4 h-4 text-zinc-600" /></div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-zinc-900">Chrome on macOS \u00b7 This device</div>
            <div className="text-xs text-zinc-500">Pittsburgh, PA \u00b7 Active now</div>
          </div>
          <span className="text-xs font-medium text-emerald-700">Current</span>
        </div>
        <Btn variant="secondary" size="sm" className="mt-3">Sign out everywhere</Btn>
      </Card>
    </div>
  );
}

function SettingsEbay() {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between mb-4 gap-2 flex-wrap">
        <div>
          <div className="text-base font-semibold tracking-tight text-zinc-900">eBay store</div>
          <div className="text-xs text-zinc-500 mt-0.5">Connected via OAuth on Jan 14, 2026.</div>
        </div>
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> Connected
        </span>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-5">
        <Field label="Store handle" value={VENDOR.ebayStore} mono />
        <Field label="Active listings" value="38 of 247 SKUs" />
        <Field label="Last sync" value="3 minutes ago" />
        <Field label="Token expires" value="Apr 10, 2026 (14 days)" warn />
      </div>

      <div className="rounded-xl p-4 border border-amber-200 bg-amber-50 flex items-start gap-3 mb-4 flex-wrap">
        <AlertTriangle className="w-4 h-4 text-amber-700 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-amber-900">Reconnect before token expires</div>
          <div className="text-xs text-amber-800 mt-0.5">After expiry, you'll have a 72-hour grace period before listings auto-end.</div>
        </div>
        <Btn variant="primary" size="sm">Reconnect</Btn>
      </div>

      <div className="flex justify-between items-center pt-4 border-t border-zinc-100 gap-2 flex-wrap">
        <div>
          <div className="text-sm font-semibold text-zinc-900">Disconnect eBay</div>
          <div className="text-xs text-zinc-500">Listings will auto-end after a 72-hour grace period.</div>
        </div>
        <Btn variant="danger" size="sm"><Unlink className="w-4 h-4" />Disconnect</Btn>
      </div>
    </Card>
  );
}

function SettingsWallet() {
  return (
    <Card className="p-5">
      <div className="text-base font-semibold tracking-tight text-zinc-900 mb-1">Auto-reload</div>
      <div className="text-xs text-zinc-500 mb-5">.ops requires at least one funding method on file. Auto-reload keeps your account fundable for incoming orders.</div>

      <div className="grid grid-cols-2 gap-4 mb-5">
        <Field label="Minimum balance" value={`$${WALLET.minBalance}.00`} sub="Triggers reload below this" />
        <Field label="Max single reload" value={`$${WALLET.maxReload}.00`} sub="Orders pause if exceeded" />
      </div>

      <div className="text-sm font-semibold text-zinc-900 mb-2">Funding methods</div>
      <FundingMethod icon={Building2} title="ACH (Plaid verified)" sub="Wells Fargo \u2022\u2022\u2022\u2022 4421" badge="Default" />
      <FundingMethod icon={CreditCard} title="Visa \u2022\u2022\u2022\u2022 8821" sub="Expires 09/2028" />
      <FundingMethod icon={Coins} title="USDC on Base" sub="Allowance: $1,000" comingSoon />
    </Card>
  );
}

function SettingsNotifications() {
  const events = [
    { k: 'order_accepted', label: 'Order accepted', critical: false },
    { k: 'order_shipped', label: 'Order shipped (with tracking)', critical: false },
    { k: 'order_delivered', label: 'Order delivered', critical: false },
    { k: 'order_rejected', label: 'Order rejected', critical: true },
    { k: 'reload_success', label: 'Auto-reload completed', critical: false },
    { k: 'reload_failed', label: 'Auto-reload failed', critical: true },
    { k: 'low_balance', label: 'Low balance warning', critical: false },
    { k: 'ebay_token', label: 'eBay token expiring', critical: true },
    { k: 'rma_status', label: 'RMA status changes', critical: false },
    { k: 'account_suspended', label: 'Account suspended', critical: true },
  ];

  return (
    <Card className="p-5">
      <div className="text-base font-semibold tracking-tight text-zinc-900 mb-1">Notification preferences</div>
      <div className="text-xs text-zinc-500 mb-5">Critical events cannot be muted.</div>

      <div className="grid gap-2 px-2 py-2 border-b border-zinc-100 text-xs font-semibold uppercase tracking-wider text-zinc-500" style={{ gridTemplateColumns: '1fr 50px 50px 50px 50px' }}>
        <div>Event</div>
        <div className="text-center">Email</div>
        <div className="text-center">In-app</div>
        <div className="text-center">SMS</div>
        <div className="text-center">Webhook</div>
      </div>
      {events.map(e => (
        <div key={e.k} className="grid gap-2 px-2 py-3 border-b border-zinc-100 items-center" style={{ gridTemplateColumns: '1fr 50px 50px 50px 50px' }}>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="text-sm text-zinc-800">{e.label}</div>
            {e.critical && (
              <span className="text-xs font-semibold px-1.5 py-0.5 rounded bg-red-50 text-red-700 uppercase tracking-wider">Critical</span>
            )}
          </div>
          {['email', 'app', 'sms', 'webhook'].map(ch => (
            <div key={ch} className="flex justify-center">
              <Toggle defaultOn={ch === 'email' || ch === 'app' || (e.critical && ch === 'sms')} disabled={e.critical && (ch === 'email' || ch === 'app')} />
            </div>
          ))}
        </div>
      ))}
    </Card>
  );
}

function SettingsAPI() {
  const [show, setShow] = useState(false);
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between mb-4 gap-2 flex-wrap">
        <div>
          <div className="text-base font-semibold tracking-tight text-zinc-900">API keys</div>
          <div className="text-xs text-zinc-500 mt-0.5">For programmatic access. Docs at <span style={{ color: PURPLE_DARK }}>docs.cardshellz.io</span>.</div>
        </div>
        <Btn variant="primary" size="sm"><Plus className="w-4 h-4" />New key</Btn>
      </div>

      <div className="border border-zinc-200 rounded-lg overflow-hidden">
        <div className="px-4 py-3 bg-zinc-50 border-b border-zinc-100 flex items-center gap-3 flex-wrap">
          <Key className="w-4 h-4 text-zinc-500" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-zinc-900">Production \u00b7 Full access</div>
            <div className="text-xs text-zinc-500">Created Jan 18, 2026 \u00b7 Last used 12 minutes ago</div>
          </div>
          <span className="text-xs font-semibold px-2 py-0.5 rounded bg-emerald-50 text-emerald-700">Active</span>
        </div>
        <div className="px-4 py-3 flex items-center gap-2 flex-wrap">
          <code className="flex-1 text-xs font-mono text-zinc-700 truncate min-w-0">
            {show ? 'csops_live_4f8a91b3c2d7e0f5a8b1c4d7e2f5a8b1' : 'csops_live_\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'}
          </code>
          <button onClick={() => setShow(!show)} className="p-1.5 rounded hover:bg-zinc-100">
            {show ? <EyeOff className="w-4 h-4 text-zinc-500" /> : <Eye className="w-4 h-4 text-zinc-500" />}
          </button>
          <button className="p-1.5 rounded hover:bg-zinc-100"><Copy className="w-4 h-4 text-zinc-500" /></button>
        </div>
      </div>
    </Card>
  );
}

function SettingsWebhooks() {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between mb-4 gap-2 flex-wrap">
        <div>
          <div className="text-base font-semibold tracking-tight text-zinc-900">Webhooks</div>
          <div className="text-xs text-zinc-500 mt-0.5">Receive HMAC-signed events at your endpoint.</div>
        </div>
        <Btn variant="primary" size="sm"><Plus className="w-4 h-4" />Add endpoint</Btn>
      </div>

      <div className="border border-zinc-200 rounded-lg overflow-hidden">
        <div className="px-4 py-3.5 flex items-center gap-3 flex-wrap">
          <Webhook className="w-4 h-4 text-zinc-500" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-mono text-zinc-900 truncate">https://api.castellanocards.com/hooks/ops</div>
            <div className="text-xs text-zinc-500 mt-0.5">8 events subscribed \u00b7 99.4% delivery success (last 30d)</div>
          </div>
          <span className="text-xs font-semibold px-2 py-0.5 rounded bg-emerald-50 text-emerald-700">Healthy</span>
          <Btn variant="ghost" size="sm">Configure</Btn>
        </div>
      </div>
    </Card>
  );
}

function SettingsPage() {
  const [tab, setTab] = useState('account');
  const tabs = [
    { k: 'account', label: 'Account' },
    { k: 'ebay', label: 'eBay connection' },
    { k: 'wallet', label: 'Wallet & payment' },
    { k: 'notifications', label: 'Notifications' },
    { k: 'api', label: 'API keys' },
    { k: 'webhooks', label: 'Webhooks' },
  ];

  return (
    <div>
      <Topbar title="Settings" subtitle="Manage your account, integrations, and preferences." />

      <div className="grid gap-6" style={{ gridTemplateColumns: '200px 1fr' }}>
        <div>
          {tabs.map(t => (
            <button
              key={t.k}
              onClick={() => setTab(t.k)}
              className="w-full text-left px-3 py-2 rounded-lg text-sm font-medium mb-0.5 transition-colors"
              style={{
                color: tab === t.k ? PURPLE_DARK : '#3F3F46',
                background: tab === t.k ? PURPLE_TINT : 'transparent',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="min-w-0">
          {tab === 'account' && <SettingsAccount />}
          {tab === 'ebay' && <SettingsEbay />}
          {tab === 'wallet' && <SettingsWallet />}
          {tab === 'notifications' && <SettingsNotifications />}
          {tab === 'api' && <SettingsAPI />}
          {tab === 'webhooks' && <SettingsWebhooks />}
        </div>
      </div>
    </div>
  );
}

function OnboardWelcome({ next }) {
  return (
    <Card className="p-8">
      <div className="w-12 h-12 rounded-2xl flex items-center justify-center mb-5" style={{ background: PURPLE_TINT_2 }}>
        <Hexagon className="w-6 h-6" style={{ color: PURPLE_DARK }} strokeWidth={2} />
      </div>
      <h1 className="text-3xl font-semibold tracking-tight text-zinc-900 mb-2" style={{ fontFamily: '"Inter Tight", Inter, -apple-system, sans-serif', letterSpacing: '-0.01em' }}>
        Welcome to .ops, Mike.
      </h1>
      <p className="text-sm text-zinc-600 leading-relaxed mb-6">
        Card Shellz handles fulfillment. You handle the storefront. Let's get you set up \u2014 it takes about five minutes.
      </p>
      <div className="space-y-2.5 mb-7">
        {[
          { n: 1, t: 'Connect your eBay store', d: 'We push listings, pull orders, and sync tracking.' },
          { n: 2, t: 'Pick what to sell', d: 'Subscribe to our entire catalog, a category, or hand-pick SKUs.' },
          { n: 3, t: 'Fund your wallet', d: 'Auto-reload keeps fulfillment uninterrupted.' },
        ].map(s => (
          <div key={s.n} className="flex items-start gap-3 px-3 py-2.5 rounded-lg bg-zinc-50">
            <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 mt-0.5" style={{ background: PURPLE_TINT_2, color: PURPLE_DARK }}>
              {s.n}
            </div>
            <div>
              <div className="text-sm font-semibold text-zinc-900">{s.t}</div>
              <div className="text-xs text-zinc-600">{s.d}</div>
            </div>
          </div>
        ))}
      </div>
      <Btn variant="primary" size="lg" className="w-full" onClick={next}>Get started <ArrowRight className="w-4 h-4" /></Btn>
    </Card>
  );
}

function OnboardEbay({ next, back }) {
  return (
    <Card className="p-8">
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 mb-2" style={{ fontFamily: '"Inter Tight", Inter, -apple-system, sans-serif' }}>
        Connect your eBay store
      </h1>
      <p className="text-sm text-zinc-600 mb-6">
        We'll redirect you to eBay to grant .ops permission to manage your listings and orders. You can disconnect anytime in settings.
      </p>

      <div className="rounded-xl border border-zinc-200 p-5 mb-5 bg-zinc-50">
        <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-3">.ops will be able to</div>
        <div className="space-y-2">
          {[
            'Create and manage listings on your behalf',
            'Update inventory in real time as our stock changes',
            'Read incoming orders and submit them for fulfillment',
            'Push tracking back to your buyers automatically',
          ].map(t => (
            <div key={t} className="flex items-start gap-2 text-xs text-zinc-700">
              <Check className="w-4 h-4 mt-0.5 shrink-0" style={{ color: PURPLE }} />
              {t}
            </div>
          ))}
        </div>
      </div>

      <Btn variant="primary" size="lg" className="w-full" onClick={next}>
        Continue to eBay <ExternalLink className="w-4 h-4" />
      </Btn>
      <button onClick={back} className="w-full mt-3 text-xs text-zinc-500 hover:text-zinc-700">\u2190 Back</button>
    </Card>
  );
}

function OnboardProducts({ next, back }) {
  const [mode, setMode] = useState('cat');
  return (
    <Card className="p-8">
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 mb-2" style={{ fontFamily: '"Inter Tight", Inter, -apple-system, sans-serif' }}>
        What do you want to sell?
      </h1>
      <p className="text-sm text-zinc-600 mb-6">
        Start broad or narrow \u2014 you can change this anytime from the catalog.
      </p>

      <div className="space-y-2 mb-6">
        {[
          { k: 'all', t: 'Entire catalog', d: '247 SKUs \u00b7 auto-listed and kept in sync', icon: Globe },
          { k: 'cat', t: 'Pick categories', d: 'Subscribe to entire categories like Toploaders or Sleeves', icon: Box },
          { k: 'pick', t: 'Hand-pick individual products', d: 'Maximum control. Best for niche or focused stores.', icon: Package },
        ].map(o => {
          const Icon = o.icon;
          const isSel = mode === o.k;
          return (
            <button
              key={o.k}
              onClick={() => setMode(o.k)}
              className="w-full flex items-start gap-3 p-4 rounded-xl border-2 text-left transition-all"
              style={{
                borderColor: isSel ? PURPLE : '#E4E4E7',
                background: isSel ? PURPLE_TINT : 'white',
              }}
            >
              <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: isSel ? 'white' : '#F4F4F5' }}>
                <Icon className="w-4 h-4" style={{ color: isSel ? PURPLE_DARK : '#52525B' }} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-zinc-900">{o.t}</div>
                <div className="text-xs text-zinc-600 mt-0.5">{o.d}</div>
              </div>
              <div className="w-5 h-5 rounded-full border-2 mt-1 flex items-center justify-center" style={{
                borderColor: isSel ? PURPLE : '#D4D4D8',
                background: isSel ? PURPLE : 'white',
              }}>
                {isSel && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
              </div>
            </button>
          );
        })}
      </div>

      <Btn variant="primary" size="lg" className="w-full" onClick={next}>Continue <ArrowRight className="w-4 h-4" /></Btn>
      <button onClick={back} className="w-full mt-3 text-xs text-zinc-500 hover:text-zinc-700">\u2190 Back</button>
    </Card>
  );
}

function OnboardWallet({ next, back }) {
  return (
    <Card className="p-8">
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 mb-2" style={{ fontFamily: '"Inter Tight", Inter, -apple-system, sans-serif' }}>
        Set up your wallet
      </h1>
      <p className="text-sm text-zinc-600 mb-6">
        Orders are paid from your .ops wallet. Auto-reload keeps fulfillment uninterrupted.
      </p>

      <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">Initial deposit</div>
      <div className="flex gap-2 mb-5 flex-wrap">
        {[100, 200, 500, 1000].map(v => (
          <button key={v} className="flex-1 px-3 py-2.5 rounded-lg border-2 border-zinc-200 hover:border-zinc-300 text-sm font-semibold text-zinc-900 min-w-0">
            ${v}
          </button>
        ))}
      </div>

      <div className="rounded-xl border border-zinc-200 p-4 mb-5">
        <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-3">Auto-reload settings</div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="text-xs text-zinc-500 mb-1">When balance falls below</div>
            <div className="px-3 py-2 border border-zinc-200 rounded-lg text-sm font-semibold tabular-nums">$50.00</div>
          </div>
          <div>
            <div className="text-xs text-zinc-500 mb-1">Max single charge</div>
            <div className="px-3 py-2 border border-zinc-200 rounded-lg text-sm font-semibold tabular-nums">$500.00</div>
          </div>
        </div>
      </div>

      <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">Funding method</div>
      <div className="space-y-2 mb-6">
        <label className="flex items-center gap-3 p-3 border-2 rounded-xl cursor-pointer" style={{ borderColor: PURPLE, background: PURPLE_TINT }}>
          <input type="radio" name="fund" defaultChecked />
          <Building2 className="w-4 h-4" style={{ color: PURPLE_DARK }} />
          <div className="flex-1">
            <div className="text-sm font-semibold text-zinc-900">ACH (Plaid)</div>
            <div className="text-xs text-zinc-600">No fees \u00b7 1-2 day clearing \u00b7 Recommended</div>
          </div>
        </label>
        <label className="flex items-center gap-3 p-3 border-2 border-zinc-200 rounded-xl cursor-pointer hover:border-zinc-300">
          <input type="radio" name="fund" />
          <CreditCard className="w-4 h-4 text-zinc-600" />
          <div className="flex-1">
            <div className="text-sm font-semibold text-zinc-900">Credit or debit card</div>
            <div className="text-xs text-zinc-600">Instant \u00b7 ~3% processing fee</div>
          </div>
        </label>
        <label className="flex items-center gap-3 p-3 border-2 border-zinc-200 rounded-xl cursor-not-allowed opacity-60">
          <input type="radio" name="fund" disabled />
          <Coins className="w-4 h-4 text-zinc-600" />
          <div className="flex-1">
            <div className="text-sm font-semibold text-zinc-900">USDC on Base</div>
            <div className="text-xs text-zinc-600">Available Phase 2</div>
          </div>
        </label>
      </div>

      <Btn variant="primary" size="lg" className="w-full" onClick={next}>Fund wallet & continue <ArrowRight className="w-4 h-4" /></Btn>
      <button onClick={back} className="w-full mt-3 text-xs text-zinc-500 hover:text-zinc-700">\u2190 Back</button>
    </Card>
  );
}

function OnboardDone({ done }) {
  return (
    <Card className="p-8 text-center">
      <div className="w-16 h-16 rounded-full mx-auto mb-5 flex items-center justify-center" style={{ background: PURPLE_TINT_2 }}>
        <CheckCircle2 className="w-8 h-8" style={{ color: PURPLE_DARK }} />
      </div>
      <h1 className="text-3xl font-semibold tracking-tight text-zinc-900 mb-2" style={{ fontFamily: '"Inter Tight", Inter, -apple-system, sans-serif', letterSpacing: '-0.01em' }}>
        You're live.
      </h1>
      <p className="text-sm text-zinc-600 mb-6 leading-relaxed">
        Your selected products are pushing to eBay now. First listings should be active in 2\u20135 minutes. You'll get an email when they're live.
      </p>

      <div className="rounded-xl bg-zinc-50 border border-zinc-100 p-4 mb-6 text-left">
        <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-3">What's next</div>
        <div className="space-y-2 text-xs">
          <div className="flex items-start gap-2"><Check className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: PURPLE }} /><span className="text-zinc-700">Watch your dashboard for the first order</span></div>
          <div className="flex items-start gap-2"><Check className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: PURPLE }} /><span className="text-zinc-700">Card Shellz ships within 1 business day, every time</span></div>
          <div className="flex items-start gap-2"><Check className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: PURPLE }} /><span className="text-zinc-700">Tracking flows back to your buyer automatically</span></div>
        </div>
      </div>

      <Btn variant="primary" size="lg" className="w-full" onClick={done}>Go to dashboard <ArrowRight className="w-4 h-4" /></Btn>
    </Card>
  );
}

function Onboarding({ onComplete }) {
  const [step, setStep] = useState(0);
  const steps = ['Welcome', 'Connect eBay', 'Pick products', 'Fund wallet', 'Done'];

  return (
    <div className="flex flex-col" style={{ background: '#FAFAFA', minHeight: '100vh' }}>
      <div className="bg-white border-b border-zinc-200 px-6 py-4 flex items-center gap-6 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-md flex items-center justify-center" style={{ background: '#0A0A0A' }}>
            <Hexagon className="w-3.5 h-3.5" style={{ color: PURPLE }} strokeWidth={2.5} />
          </div>
          <div className="text-sm font-semibold tracking-tight text-zinc-900">.ops</div>
        </div>
        <div className="flex-1 flex items-center gap-2 min-w-0 overflow-x-auto">
          {steps.map((s, i) => (
            <React.Fragment key={i}>
              <div className="flex items-center gap-2 shrink-0">
                <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold transition-all" style={{
                  background: i <= step ? PURPLE : '#E4E4E7',
                  color: i <= step ? 'white' : '#71717A',
                }}>
                  {i < step ? <Check className="w-3 h-3" strokeWidth={3} /> : i + 1}
                </div>
                <span className="text-xs font-medium" style={{ color: i <= step ? PURPLE_DARK : '#71717A' }}>{s}</span>
              </div>
              {i < steps.length - 1 && <div className="flex-1 h-px bg-zinc-200 min-w-4" />}
            </React.Fragment>
          ))}
        </div>
        <button onClick={onComplete} className="text-xs text-zinc-500 hover:text-zinc-700 shrink-0">Skip preview \u2192</button>
      </div>

      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full" style={{ maxWidth: 520 }}>
          {step === 0 && <OnboardWelcome next={() => setStep(1)} />}
          {step === 1 && <OnboardEbay next={() => setStep(2)} back={() => setStep(0)} />}
          {step === 2 && <OnboardProducts next={() => setStep(3)} back={() => setStep(1)} />}
          {step === 3 && <OnboardWallet next={() => setStep(4)} back={() => setStep(2)} />}
          {step === 4 && <OnboardDone done={onComplete} />}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [view, setView] = useState('app');
  const [page, setPage] = useState('dashboard');

  useEffect(() => {
    const id = 'ops-portal-fonts';
    if (!document.getElementById(id)) {
      const link = document.createElement('link');
      link.id = id;
      link.rel = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Inter+Tight:wght@500;600;700&display=swap';
      document.head.appendChild(link);
    }
  }, []);

  if (view === 'onboarding') {
    return <Onboarding onComplete={() => { setView('app'); setPage('dashboard'); }} />;
  }

  return (
    <div className="flex" style={{ background: '#FAFAFA', fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif', minHeight: '100vh' }}>
      <Sidebar active={page} onNavigate={setPage} />

      <main className="flex-1 overflow-auto min-w-0">
        <div className="px-6 py-6 max-w-6xl mx-auto">
          <div className="flex items-center justify-end gap-2 mb-2">
            <button onClick={() => setView('onboarding')} className="text-xs text-zinc-500 hover:text-zinc-700 px-2 py-1">
              Preview onboarding flow
            </button>
          </div>

          {page === 'dashboard' && <Dashboard onNavigate={setPage} />}
          {page === 'catalog' && <Catalog />}
          {page === 'orders' && <Orders />}
          {page === 'wallet' && <WalletPage />}
          {page === 'returns' && <Returns />}
          {page === 'settings' && <SettingsPage />}
        </div>
      </main>
    </div>
  );
}
