# Warehouse Operations & Inventory Lifecycle

## 1. Order Ingestion (OMS)
**Trigger:** Customer places order on Shopify.
- **WMS Action:** Import Order.
- **Inventory State:** `Available` → `Allocated` (Soft Reserve).
- **Order Status:** `Pending Allocation`.
- **Note:** Inventory is reserved *logically* but not physically moved yet.

## 2. Wave / Batch Planning
**Trigger:** Warehouse Manager runs "Wave" or "Batch" job (e.g., "All Next Day Air" or "Zone A Orders").
- **WMS Action:**
    1. Locks specific inventory units to these orders.
    2. Generates a **Batch ID** (e.g., #BATCH-4921).
    3. Generates a **Pick Path** (optimized route).
- **Inventory State:** `Allocated` → `Hard Reserved` (Locked to Batch).
- **Order Status:** `Ready to Pick`.

## 3. Picking (Mobile App)
**Trigger:** Worker selects Batch #4921 on scanner.
**Process:**
1.  **Direct to Bin:** App guides worker to Location `A-01-02`.
2.  **Scan Bin:** Verifies location.
3.  **Scan Item:** Verifies SKU.
4.  **Action:** Worker physically moves item from **Bin** to **Tote/Cart**.
5.  **Confirm:** Worker hits "Confirm".
- **Inventory Movement:** `Bin Location` (A-01-02) → `Movable Unit` (Tote #55 / Cart #3).
- **Order Status:** `Picking in Progress`.

## 4. Drop Off (Staging)
**Trigger:** Worker finishes Batch #4921.
- **Action:** Worker drops Tote #55 at the **Packing Station**.
- **WMS Action:** "Drop" scan (associates Tote #55 with Pack Station A).
- **Inventory Movement:** `Movable Unit` (Tote #55) → `Pack Station Staging`.
- **Order Status:** `Picked / Awaiting Pack`.

## 5. Packing (Desktop Station)
**Trigger:** Packer scans Tote #55 or an Item from the tote.
**Process:**
1.  **System Identification:** WMS identifies which Orders are in this Tote.
2.  **Scan to Box:** Packer scans item again to verify it goes into **Shipping Box A**.
3.  **Close Box:** Packer seals box.
- **Inventory Movement:** `Pack Station Staging` → `Outbound Box`.
- **Order Status:** `Packed`.

## 6. Shipping (Separate Module)
**Trigger:** Weighing & Label Generation.
- **Action:** Generate Label -> Carrier Scan.
- **Inventory Action:** **Inventory Decrement** (Removed from Asset Ledger).
- **External Sync:** Update Shopify "Fulfilled" + Tracking Number.
- **Order Status:** `Shipped`.
