"""Generate the shared mock dataset for the Echelon Reorder Analysis design mockups.

Every derived number is computed with the SAME formulas as the real engine
(purchasing-recommendation.engine.ts / purchasing-demand-forecast.engine.ts, verified 2026-07-26):
  - blended ADU = sum(window_adu * weight)/100, seasonal weight zeroed+renormalized when seasonal window empty
  - growth-adjusted ADU = ADU * product of active adjustment multipliers   (NEW design concept)
  - reorderPoint = ceil((leadTime + safetyStock) * adjustedADU)
  - adjustedReorderPoint = reorderPoint + weighted forward-demand pieces (ceil(pieces*conf/100))
  - effectiveSupply = available + onOrder ; gap = max(0, adjRP - effSupply)
  - suggested = ceil(max(gap, MOQ) / increment) * increment
  - daysOfSupply = round(available / adjustedADU), 9999 if no usage
  - status: stockout | no_movement | on_order | order_now | order_soon (DoS <= LT*1.5) | ok
Output: data.js  (window.MOCK = {...})
"""
import json, math

AS_OF = "2026-07-26"
W = {"short": 30, "standard": 35, "long": 20, "seasonal": 15}

VENDORS = [
    {"id": 1, "code": "GTS",  "name": "GTS Distribution",   "leadTimeDays": 7,  "terms": "Net 30", "email": "orders@gtsdistribution.com", "stage": 3, "caps": {"maxPoCents": 250000, "maxDayCents": 500000, "maxLinesRun": 25}},
    {"id": 2, "code": "SHD",  "name": "Southern Hobby",     "leadTimeDays": 10, "terms": "Net 30", "email": "sales@southernhobby.com",    "stage": 2, "caps": {"maxPoCents": 150000, "maxDayCents": 300000, "maxLinesRun": 25}},
    {"id": 3, "code": "PSC",  "name": "Peach State Cards",  "leadTimeDays": 12, "terms": "Net 15", "email": "po@peachstatecards.com",     "stage": 1, "caps": None},
    {"id": 4, "code": "BCW",  "name": "BCW Direct",         "leadTimeDays": 5,  "terms": "Net 30", "email": "wholesale@bcwsupplies.com",  "stage": 3, "caps": {"maxPoCents": 200000, "maxDayCents": 250000, "maxLinesRun": 25}},
    {"id": 5, "code": "MEX",  "name": "Magazine Exchange",  "leadTimeDays": 14, "terms": "Prepaid", "email": "orders@magazineexchange.com", "stage": 1, "caps": None},
]

# Growth Adjustments (the NEW % lever). multiplier applies when active on AS_OF.
ADJUSTMENTS = [
    {"id": 1, "scope": "category", "target": "Sealed - Pokemon", "pct": 20,  "start": "2026-07-15", "end": "2026-08-31", "reason": "Summer set surge - Destined Rivals wave 2", "active": True,  "createdBy": "owner"},
    {"id": 2, "scope": "business", "target": "All SKUs",         "pct": 15,  "start": "2026-11-01", "end": "2026-12-24", "reason": "Holiday season baseline lift",             "active": False, "createdBy": "owner"},
    {"id": 3, "scope": "category", "target": "Sealed - Pokemon", "pct": 40,  "start": "2026-11-01", "end": "2026-11-30", "reason": "Black Friday + Mega Evolution launch",     "active": False, "createdBy": "owner"},
]

# Demand events. sku=None => category-level (allocated by 90d sales mix).
EVENTS = [
    {"id": 11, "name": "Mega Evolution ETB preorder drop", "type": "preorder",  "status": "active",  "sku": "PKM-MEGA-ETB", "pieces": 900,  "confidence": "high",   "start": "2026-09-26", "end": "2026-10-10"},
    {"id": 12, "name": "Collect-A-Con wholesale order",    "type": "wholesale", "status": "planned", "sku": "PKM-PRE-ETB",  "pieces": 300,  "confidence": "high",   "start": "2026-08-14", "end": "2026-08-16"},
    {"id": 13, "name": "Black Friday supplies push",       "type": "promotion", "status": "planned", "sku": None, "category": "Supplies", "pieces": 2500, "confidence": "medium", "start": "2026-11-27", "end": "2026-12-01"},
]
CONF_W = {"high": 100, "medium": 70, "low": 40}
HORIZON = 90  # forward-demand horizon days

# sku, name, category, productLine, vendorCode, unitCostCents, moq, inc(purchase-uom pieces), leadOverride, safety,
# u7, u30, u90, uSeas30, prior30, onHand, reserved, onOrder, openPoCount, poEta, ageDays, excluded
SKUS = [
 ["PKM-PRE-ETB",  "Prismatic Evolutions Elite Trainer Box", "Sealed - Pokemon", "Prismatic Evolutions", "GTS", 4650, 10, 10, None, 7, 96, 342, 810, 168, 236, 118, 22, 0,   0, None, 12,  False],
 ["PKM-PRE-BB",   "Prismatic Evolutions Booster Bundle",    "Sealed - Pokemon", "Prismatic Evolutions", "GTS", 2350, 12, 6,  None, 7, 58, 214, 566, 121, 189, 176, 14, 0,   0, None, 9,   False],
 ["PKM-DRI-BB36", "Destined Rivals Booster Box (36ct)",     "Sealed - Pokemon", "Destined Rivals",      "GTS", 10800, 6, 6,  None, 7, 41, 150, 366, 0,   139, 84,  8,  144, 2, "2026-08-04", 31, False],
 ["PKM-151-UPC",  "151 Ultra Premium Collection",           "Sealed - Pokemon", "Scarlet & Violet",     "SHD", 9200, 6, 6,  None, 7, 18, 74,  231, 89,  81,  6,   6,  0,   0, None, 44,  False],
 ["PKM-SVP-TIN",  "Paldea Adventure Chest Tin",             "Sealed - Pokemon", "Scarlet & Violet",     "SHD", 2100, 12, 12, None, 7, 22, 96,  270, 208, 90,  310, 12, 0,   0, None, 61,  False],
 ["PKM-MEGA-ETB", "Mega Evolution ETB (Preorder)",          "Sealed - Pokemon", "Mega Evolution",       "GTS", 5200, 10, 10, 21,  7, 4,  9,   9,   0,   0,   0,   0,  0,   0, None, 6,   False],
 ["TOP-25C-HOB",  "2025 Topps Chrome Hobby Box",            "Sealed - Sports",  "2025 Topps Chrome",    "PSC", 7400, 8, 8,  None, 7, 26, 118, 342, 96,  124, 214, 10, 0,   0, None, 27,  False],
 ["TOP-25S1-BL",  "2025 Topps Series One Blaster",          "Sealed - Sports",  "2025 Topps Chrome",    "PSC", 1950, 24, 12, None, 7, 9,  62,  294, 88,  131, 342, 4,  0,   0, None, 88,  False],
 ["TOP-25B-JMB",  "2025 Bowman Jumbo Hobby Box",            "Sealed - Sports",  "2025 Bowman",          "MEX", 15800, 4, 4,  None, 7, 3,  17,  92,  41,  46,  164, 2,  0,   0, None, 196, False],
 ["PAN-PRZ-HOB",  "Prizm Basketball Hobby Box",             "Sealed - Sports",  "Prizm Basketball",     "PSC", 12600, 4, 4,  25,   7, 19, 74,  198, 66,  70,  92,  6,  0,   0, None, 33,  False],
 ["BCW-TL-100",   "BCW Toploaders 3x4 (100ct pack)",        "Supplies",         "BCW Essentials",       "BCW", 680,  50, 25, None, 7, 210, 884, 2561, 792, 858, 1120, 96, 0,  0, None, 15,  False],
 ["ULP-DS-100",   "Ultra Pro Deck Sleeves (100ct)",         "Supplies",         "Ultra Pro Core",       "BCW", 420,  72, 36, None, 7, 118, 501, 1489, 468, 512, 1490, 60, 0,  0, None, 19,  False],
 ["BCW-GB-200",   "BCW Graded Card Box (200ct)",            "Supplies",         "BCW Essentials",       "BCW", 1150, 20, 10, None, 7, 0,  0,   0,   0,   2,   86,  0,  0,   0, None, 214, False],
 ["SGL-CHZ-PIKA", "Pikachu ex 238/191 (Single)",            "Singles",          "Singles Inventory",    None,  0,    1,  1,  None, 7, 5,  21,  60,  18,  24,  3,   0,  0,   0, None, 5,   True],
]

EXCLUSION_RULES = [
    {"id": 1, "field": "category",   "value": "Singles",      "excludedCount": 34, "addedBy": "owner", "addedAt": "2026-05-02"},
    {"id": 2, "field": "tag",        "value": "discontinued", "excludedCount": 2,  "addedBy": "owner", "addedAt": "2026-05-02"},
    {"id": 3, "field": "sku_prefix", "value": "GRD-",         "excludedCount": 1,  "addedBy": "auto-suggest, approved by owner", "addedAt": "2026-06-18"},
]

def vendor(code):
    return next((v for v in VENDORS if v["code"] == code), None)

def active_multiplier(cat):
    m = 1.0
    labels = []
    for a in ADJUSTMENTS:
        if not a["active"]:
            continue
        if a["scope"] == "business" or (a["scope"] == "category" and a["target"] == cat):
            m *= 1 + a["pct"] / 100.0
            labels.append({"label": f"+{a['pct']}% {a['target']}", "pct": a["pct"], "id": a["id"], "reason": a["reason"], "range": f"{a['start']} to {a['end']}"})
    return m, labels

import datetime
def in_horizon(e):
    # engine: start_date <= today + horizon AND end_date >= today
    today = datetime.date.fromisoformat(AS_OF)
    return (datetime.date.fromisoformat(e["start"]) <= today + datetime.timedelta(days=HORIZON)
            and datetime.date.fromisoformat(e["end"]) >= today)

def fwd_demand(sku, cat, mix_by_cat):
    total, rows = 0, []
    for e in EVENTS:
        if e["status"] not in ("planned", "active") or not in_horizon(e):
            continue
        if e["sku"] == sku:
            w = math.ceil(e["pieces"] * CONF_W[e["confidence"]] / 100)
            rows.append({"event": e["name"], "type": e["type"], "raw": e["pieces"], "confidence": e["confidence"], "weighted": w, "allocated": False})
            total += w
        elif e["sku"] is None and e.get("category") == cat:
            share = mix_by_cat[cat].get(sku, 0)
            alloc_raw = round(e["pieces"] * share)          # materialized integer allocation by 90d mix
            w = math.ceil(alloc_raw * CONF_W[e["confidence"]] / 100)
            if alloc_raw > 0:
                rows.append({"event": e["name"], "type": e["type"], "raw": alloc_raw, "confidence": e["confidence"], "weighted": w, "allocated": True, "sharePct": round(share * 100, 1)})
                total += w
    return total, rows

def compute():
    # 90d sales mix per category (for category-event allocation)
    mix_by_cat = {}
    for cat in {r[2] for r in SKUS}:
        rows = [r for r in SKUS if r[2] == cat and not r[21]]
        tot = sum(r[12] for r in rows) or 1
        mix_by_cat[cat] = {r[0]: r[12] / tot for r in rows}

    items = []
    for r in SKUS:
        (sku, name, cat, line, vcode, cost, moq, inc, lt_ov, ss,
         u7, u30, u90, useas, prior30, on_hand, reserved, on_order, po_count, po_eta, age, excluded) = r
        v = vendor(vcode)
        lt = lt_ov or (v["leadTimeDays"] if v else 14)
        lt_src = "override" if lt_ov else ("vendor" if v else "default")

        w7, w30, w90, wS = u7 / 7, u30 / 30, u90 / 90, useas / 30
        weights = dict(W)
        if useas == 0:
            scale = 100 / (100 - weights["seasonal"])
            weights = {"short": weights["short"] * scale, "standard": weights["standard"] * scale,
                       "long": weights["long"] * scale, "seasonal": 0}
        adu = (w7 * weights["short"] + w30 * weights["standard"] + w90 * weights["long"] + wS * weights["seasonal"]) / 100

        mult, adj_labels = (1.0, []) if excluded else active_multiplier(cat)
        adu_adj = adu * mult

        available = on_hand - reserved
        fwd, fwd_rows = (0, []) if excluded else fwd_demand(sku, cat, mix_by_cat)
        rp = math.ceil((lt + ss) * adu_adj)
        adj_rp = rp + fwd
        eff = available + on_order
        gap = max(0, adj_rp - eff)
        suggested = 0 if (gap == 0 or excluded or v is None) else math.ceil(max(gap, moq) / inc) * inc

        # baseline (without growth adjustments) for the Impact Preview before/after view
        rp0 = math.ceil((lt + ss) * adu)
        adj_rp0 = rp0 + fwd
        gap0 = max(0, adj_rp0 - eff)
        suggested0 = 0 if (gap0 == 0 or excluded or v is None) else math.ceil(max(gap0, moq) / inc) * inc
        dos = 9999 if adu_adj == 0 else round(available / adu_adj) if available > 0 else 0

        ratio = (u30 / prior30) if prior30 > 0 else (99 if u30 > 0 else 1)
        trend = "rising" if ratio >= 1.5 else "falling" if ratio <= 0.5 else "flat"
        quality = "no_recent_demand" if u30 == 0 else "thin_history" if u30 < 3 or (sku == "PKM-MEGA-ETB") else "normal"
        confidence = "low" if quality != "normal" else ("medium" if trend != "flat" or age > 180 else "high")

        if excluded:            status = "excluded"
        elif available <= 0 and adu_adj > 0: status = "stockout"
        elif adu_adj == 0:      status = "no_movement"
        elif available <= adj_rp and on_order > 0 and eff >= adj_rp: status = "on_order"
        elif available <= adj_rp: status = "order_now"
        elif dos <= lt * 1.5:   status = "order_soon"
        else:                   status = "ok"

        items.append({
            "sku": sku, "name": name, "category": cat, "productLine": line,
            "vendor": v["name"] if v else None, "vendorCode": vcode, "leadTimeDays": lt, "leadTimeSource": lt_src,
            "safetyStockDays": ss, "unitCostCents": cost, "moq": moq, "increment": inc,
            "usage": {"d7": u7, "d30": u30, "d90": u90, "seasonal30": useas, "prior30": prior30},
            "windowAdu": {"d7": round(w7, 2), "d30": round(w30, 2), "d90": round(w90, 2), "seasonal": round(wS, 2)},
            "blendWeights": {k: round(vv, 1) for k, vv in weights.items()},
            "adu": round(adu, 2), "growthMultiplier": round(mult, 2), "growthAdjustments": adj_labels,
            "adjustedAdu": round(adu_adj, 2),
            "onHand": on_hand, "reserved": reserved, "available": available,
            "onOrder": on_order, "openPoCount": po_count, "poEta": po_eta,
            "forwardDemandPieces": fwd, "forwardDemandRows": fwd_rows,
            "reorderPoint": rp, "adjustedReorderPoint": adj_rp, "effectiveSupply": eff,
            "gap": gap, "suggestedPieces": suggested, "suggestedValueCents": suggested * cost,
            "baseline": {"reorderPoint": rp0, "adjustedReorderPoint": adj_rp0, "gap": gap0, "suggestedPieces": suggested0},
            "daysOfSupply": dos, "trend": trend, "trendRatio": round(ratio, 2),
            "demandQuality": quality, "confidence": confidence, "lastSaleDaysAgo": age,
            "status": status, "excluded": excluded,
        })

    # rollups
    def rollup(key):
        out = {}
        for it in items:
            if it["excluded"]:
                continue
            g = out.setdefault(it[key], {"skus": 0, "belowRp": 0, "suggestedPieces": 0, "suggestedValueCents": 0,
                                          "availableValueCents": 0, "onOrderValueCents": 0, "statuses": {}})
            g["skus"] += 1
            if it["status"] in ("stockout", "order_now"):
                g["belowRp"] += 1
            g["suggestedPieces"] += it["suggestedPieces"]
            g["suggestedValueCents"] += it["suggestedValueCents"]
            g["availableValueCents"] += it["available"] * it["unitCostCents"]
            g["onOrderValueCents"] += it["onOrder"] * it["unitCostCents"]
            g["statuses"][it["status"]] = g["statuses"].get(it["status"], 0) + 1
        return out

    return {"asOf": AS_OF, "horizonDays": HORIZON, "confidenceWeights": CONF_W,
            "policy": {"method": "weighted_blend_v1", "windows": {"short": 7, "standard": 30, "long": 90, "seasonal": 30},
                        "weights": W, "cohort": "3f9a2c1e", "forecastVersion": 2},
            "vendors": VENDORS, "adjustments": ADJUSTMENTS, "events": EVENTS,
            "exclusionRules": EXCLUSION_RULES, "items": items,
            "byCategory": rollup("category"), "byProductLine": rollup("productLine")}

data = compute()
with open("data.js", "w", encoding="utf-8") as f:
    f.write("// GENERATED by gen_data.py - do not hand-edit numbers; they follow the real engine formulas.\n")
    f.write("window.MOCK = " + json.dumps(data, indent=1) + ";\n")
print("items:", len(data["items"]))
for it in data["items"]:
    print(f"{it['sku']:14} {it['status']:12} adu={it['adu']:7} x{it['growthMultiplier']:4} rp={it['reorderPoint']:5} adjRp={it['adjustedReorderPoint']:5} eff={it['effectiveSupply']:5} sug={it['suggestedPieces']:5} dos={it['daysOfSupply']}")
