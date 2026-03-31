CREATE SCHEMA "wms";
--> statement-breakpoint
CREATE SCHEMA "oms";
--> statement-breakpoint
CREATE SCHEMA "membership";
--> statement-breakpoint
CREATE TABLE "user_audit" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "user_audit_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" varchar NOT NULL,
	"field_changed" varchar(50) NOT NULL,
	"old_value" text,
	"new_value" text,
	"changed_by" varchar,
	"changed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_assets" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "product_assets_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"product_id" integer NOT NULL,
	"product_variant_id" integer,
	"asset_type" varchar(20) DEFAULT 'image' NOT NULL,
	"url" text NOT NULL,
	"alt_text" varchar(500),
	"position" integer DEFAULT 0 NOT NULL,
	"is_primary" integer DEFAULT 0 NOT NULL,
	"width" integer,
	"height" integer,
	"file_size" integer,
	"mime_type" varchar(100),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_line_products" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "product_line_products_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"product_line_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_lines" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "product_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"code" varchar(50) NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "product_lines_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "product_types" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "product_types_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"slug" varchar(50) NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "product_types_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "product_variants" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "product_variants_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"product_id" integer NOT NULL,
	"sku" varchar(100),
	"name" text NOT NULL,
	"units_per_variant" integer DEFAULT 1 NOT NULL,
	"hierarchy_level" integer DEFAULT 1 NOT NULL,
	"parent_variant_id" integer,
	"is_base_unit" boolean DEFAULT false NOT NULL,
	"barcode" varchar(100),
	"weight_grams" integer,
	"length_mm" integer,
	"width_mm" integer,
	"height_mm" integer,
	"price_cents" integer,
	"compare_at_price_cents" integer,
	"standard_cost_cents" double precision,
	"last_cost_cents" double precision,
	"avg_cost_cents" double precision,
	"track_inventory" boolean DEFAULT true,
	"inventory_policy" varchar(20) DEFAULT 'deny',
	"shopify_variant_id" varchar(100),
	"shopify_inventory_item_id" varchar(100),
	"is_active" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0,
	"option1_name" varchar(100),
	"option1_value" varchar(100),
	"option2_name" varchar(100),
	"option2_value" varchar(100),
	"option3_name" varchar(100),
	"option3_value" varchar(100),
	"gtin" varchar(14),
	"mpn" varchar(100),
	"condition_note" text,
	"ebay_listing_excluded" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "products_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"sku" varchar(100),
	"name" text NOT NULL,
	"title" varchar(500),
	"description" text,
	"bullet_points" jsonb,
	"category" varchar(100),
	"subcategory" varchar(200),
	"brand" varchar(100),
	"manufacturer" varchar(200),
	"base_unit" varchar(20) DEFAULT 'piece' NOT NULL,
	"tags" jsonb,
	"seo_title" varchar(200),
	"seo_description" text,
	"shopify_product_id" varchar(100),
	"lead_time_days" integer DEFAULT 120 NOT NULL,
	"safety_stock_days" integer DEFAULT 7 NOT NULL,
	"status" varchar(20) DEFAULT 'active',
	"inventory_type" varchar(20) DEFAULT 'inventory' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"condition" varchar(30) DEFAULT 'new',
	"country_of_origin" varchar(2),
	"harmonized_code" varchar(20),
	"item_specifics" jsonb,
	"product_type" varchar(50),
	"ebay_browse_category_id" varchar(20),
	"ebay_browse_category_name" varchar(200),
	"dropship_eligible" boolean DEFAULT false,
	"last_pushed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "echelon_settings" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "echelon_settings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"key" varchar(100) NOT NULL,
	"value" text,
	"type" varchar(20) DEFAULT 'string' NOT NULL,
	"category" varchar(50) DEFAULT 'general' NOT NULL,
	"description" text,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "echelon_settings_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "allocation_audit_log" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "allocation_audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"product_id" integer,
	"product_variant_id" integer,
	"channel_id" integer,
	"total_atp_base" integer NOT NULL,
	"allocated_qty" integer NOT NULL,
	"previous_qty" integer,
	"allocation_method" varchar(30) NOT NULL,
	"details" jsonb,
	"triggered_by" varchar(30),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_allocation_rules" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "channel_allocation_rules_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"channel_id" integer,
	"product_id" integer,
	"product_variant_id" integer,
	"mode" varchar(10) DEFAULT 'mirror' NOT NULL,
	"share_pct" integer,
	"fixed_qty" integer,
	"floor_atp" integer DEFAULT 0,
	"floor_type" varchar(10) DEFAULT 'units',
	"ceiling_qty" integer,
	"eligible" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_product_allocation" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "channel_product_allocation_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"channel_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"min_atp_base" integer,
	"max_atp_base" integer,
	"is_listed" integer DEFAULT 1 NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_product_lines" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "channel_product_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"channel_id" integer NOT NULL,
	"product_line_id" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_sync_log" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "channel_sync_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"product_id" integer,
	"product_variant_id" integer,
	"channel_id" integer,
	"channel_feed_id" integer,
	"atp_base" integer NOT NULL,
	"pushed_qty" integer NOT NULL,
	"previous_qty" integer,
	"status" varchar(20) NOT NULL,
	"error_message" text,
	"response_code" integer,
	"duration_ms" integer,
	"triggered_by" varchar(30),
	"warehouse_id" integer,
	"shopify_location_id" varchar(50),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_warehouse_assignments" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "channel_warehouse_assignments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"channel_id" integer NOT NULL,
	"warehouse_id" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_lock_config" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "source_lock_config_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"channel_id" integer NOT NULL,
	"field_type" varchar(30) NOT NULL,
	"is_locked" integer DEFAULT 1 NOT NULL,
	"locked_by" varchar(100),
	"locked_at" timestamp DEFAULT now(),
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sync_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"channel_id" integer,
	"channel_name" varchar(100),
	"action" varchar(30) NOT NULL,
	"sku" varchar(100),
	"product_variant_id" integer,
	"previous_value" text,
	"new_value" text,
	"status" varchar(20) NOT NULL,
	"error_message" text,
	"source" varchar(20) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_settings" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sync_settings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"global_enabled" boolean DEFAULT false NOT NULL,
	"sweep_interval_minutes" integer DEFAULT 15 NOT NULL,
	"last_sweep_at" timestamp,
	"last_sweep_duration_ms" integer,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ap_payment_allocations" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ap_payment_allocations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"ap_payment_id" integer NOT NULL,
	"vendor_invoice_id" integer NOT NULL,
	"applied_amount_cents" bigint NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ap_payments" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ap_payments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"payment_number" varchar(30) NOT NULL,
	"vendor_id" integer NOT NULL,
	"payment_date" timestamp NOT NULL,
	"payment_method" varchar(20) NOT NULL,
	"reference_number" varchar(100),
	"check_number" varchar(50),
	"bank_account_label" varchar(100),
	"total_amount_cents" bigint NOT NULL,
	"currency" varchar(3) DEFAULT 'USD',
	"status" varchar(20) DEFAULT 'completed' NOT NULL,
	"voided_at" timestamp,
	"voided_by" varchar,
	"void_reason" text,
	"notes" text,
	"created_by" varchar,
	"updated_by" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ap_payments_payment_number_unique" UNIQUE("payment_number")
);
--> statement-breakpoint
CREATE TABLE "inbound_freight_allocations" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inbound_freight_allocations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"shipment_cost_id" integer NOT NULL,
	"inbound_shipment_line_id" integer NOT NULL,
	"allocation_basis_value" numeric(14, 6),
	"allocation_basis_total" numeric(14, 6),
	"share_percent" numeric(8, 4),
	"allocated_cents" bigint,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_freight_costs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inbound_freight_costs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"inbound_shipment_id" integer NOT NULL,
	"cost_type" varchar(30) NOT NULL,
	"description" text,
	"estimated_cents" bigint,
	"actual_cents" bigint,
	"currency" varchar(3) DEFAULT 'USD',
	"exchange_rate" numeric(10, 4) DEFAULT '1',
	"allocation_method" varchar(30),
	"cost_status" varchar(20) DEFAULT 'estimated',
	"invoice_number" varchar(100),
	"invoice_date" timestamp,
	"due_date" timestamp,
	"paid_date" timestamp,
	"vendor_name" text,
	"vendor_id" integer,
	"vendor_invoice_id" integer,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_shipment_lines" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inbound_shipment_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"inbound_shipment_id" integer NOT NULL,
	"purchase_order_id" integer,
	"purchase_order_line_id" integer,
	"product_variant_id" integer,
	"sku" varchar(100),
	"qty_shipped" integer NOT NULL,
	"weight_kg" numeric(10, 3),
	"length_cm" numeric(8, 2),
	"width_cm" numeric(8, 2),
	"height_cm" numeric(8, 2),
	"total_weight_kg" numeric(12, 3),
	"total_volume_cbm" numeric(12, 6),
	"chargeable_weight_kg" numeric(12, 3),
	"gross_volume_cbm" numeric(12, 6),
	"carton_count" integer,
	"pallet_count" integer,
	"allocated_cost_cents" bigint,
	"landed_unit_cost_cents" double precision,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_shipment_status_history" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inbound_shipment_status_history_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"inbound_shipment_id" integer NOT NULL,
	"from_status" varchar(20),
	"to_status" varchar(20) NOT NULL,
	"changed_by" varchar(100),
	"changed_at" timestamp DEFAULT now() NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "inbound_shipments" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inbound_shipments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"shipment_number" varchar(30) NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"mode" varchar(20),
	"carrier_name" varchar(100),
	"forwarder_name" varchar(100),
	"shipper_name" varchar(200),
	"booking_reference" varchar(100),
	"origin_port" varchar(100),
	"destination_port" varchar(100),
	"origin_country" varchar(50),
	"destination_country" varchar(50),
	"container_number" varchar(30),
	"seal_number" varchar(30),
	"container_size" varchar(10),
	"container_capacity_cbm" numeric(8, 2),
	"bol_number" varchar(100),
	"house_bol" varchar(100),
	"tracking_number" varchar(200),
	"ship_date" timestamp,
	"etd" timestamp,
	"eta" timestamp,
	"actual_arrival" timestamp,
	"customs_cleared_date" timestamp,
	"delivered_date" timestamp,
	"warehouse_id" integer,
	"total_weight_kg" numeric(12, 3),
	"total_volume_cbm" numeric(12, 6),
	"total_gross_volume_cbm" numeric(12, 6),
	"gross_weight_kg" numeric(12, 3),
	"pallet_count" integer,
	"total_pieces" integer,
	"total_cartons" integer,
	"estimated_total_cost_cents" bigint,
	"actual_total_cost_cents" bigint,
	"allocation_method_default" varchar(30),
	"notes" text,
	"internal_notes" text,
	"created_by" varchar(100),
	"closed_by" varchar(100),
	"closed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_shipments_shipment_number_unique" UNIQUE("shipment_number")
);
--> statement-breakpoint
CREATE TABLE "landed_cost_snapshots" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "landed_cost_snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"inbound_shipment_line_id" integer,
	"purchase_order_line_id" integer,
	"product_variant_id" integer,
	"po_unit_cost_cents" double precision,
	"freight_allocated_cents" bigint,
	"duty_allocated_cents" bigint,
	"insurance_allocated_cents" bigint,
	"other_allocated_cents" bigint,
	"total_landed_cost_cents" bigint,
	"landed_unit_cost_cents" double precision,
	"qty" integer,
	"finalized_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "po_approval_tiers" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "po_approval_tiers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"tier_name" text NOT NULL,
	"threshold_cents" integer NOT NULL,
	"approver_role" varchar(30) NOT NULL,
	"sort_order" integer DEFAULT 0,
	"active" integer DEFAULT 1,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "po_receipts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "po_receipts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"purchase_order_id" integer NOT NULL,
	"purchase_order_line_id" integer NOT NULL,
	"receiving_order_id" integer NOT NULL,
	"receiving_line_id" integer NOT NULL,
	"qty_received" integer DEFAULT 0 NOT NULL,
	"po_unit_cost_cents" double precision,
	"actual_unit_cost_cents" double precision,
	"variance_cents" double precision,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "po_revisions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "po_revisions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"purchase_order_id" integer NOT NULL,
	"revision_number" integer,
	"changed_by" varchar,
	"change_type" varchar(20),
	"field_changed" varchar(50),
	"old_value" text,
	"new_value" text,
	"line_id" integer,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "po_status_history" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "po_status_history_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"purchase_order_id" integer NOT NULL,
	"from_status" varchar(20),
	"to_status" varchar(20) NOT NULL,
	"changed_by" varchar,
	"changed_at" timestamp DEFAULT now() NOT NULL,
	"notes" text,
	"revision_number" integer
);
--> statement-breakpoint
CREATE TABLE "purchase_order_lines" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "purchase_order_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"purchase_order_id" integer NOT NULL,
	"line_number" integer NOT NULL,
	"product_id" integer NOT NULL,
	"product_variant_id" integer NOT NULL,
	"vendor_product_id" integer,
	"sku" varchar(100),
	"product_name" text,
	"description" text,
	"vendor_sku" varchar(100),
	"unit_of_measure" varchar(20),
	"units_per_uom" integer DEFAULT 1,
	"order_qty" integer NOT NULL,
	"received_qty" integer DEFAULT 0,
	"damaged_qty" integer DEFAULT 0,
	"returned_qty" integer DEFAULT 0,
	"cancelled_qty" integer DEFAULT 0,
	"unit_cost_cents" double precision DEFAULT 0 NOT NULL,
	"discount_percent" numeric(5, 2) DEFAULT '0',
	"discount_cents" double precision DEFAULT 0,
	"tax_rate_percent" numeric(5, 2) DEFAULT '0',
	"tax_cents" double precision DEFAULT 0,
	"line_total_cents" double precision,
	"expected_delivery_date" timestamp,
	"promised_date" timestamp,
	"received_date" timestamp,
	"fully_received_date" timestamp,
	"last_received_at" timestamp,
	"status" varchar(20) DEFAULT 'open',
	"close_short_reason" text,
	"weight_grams" integer,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "purchase_orders_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"po_number" varchar(30) NOT NULL,
	"vendor_id" integer NOT NULL,
	"warehouse_id" integer,
	"ship_to_address" text,
	"ship_from_address" text,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"po_type" varchar(20) DEFAULT 'standard',
	"priority" varchar(10) DEFAULT 'normal',
	"order_date" timestamp,
	"expected_delivery_date" timestamp,
	"confirmed_delivery_date" timestamp,
	"cancel_date" timestamp,
	"actual_delivery_date" timestamp,
	"currency" varchar(3) DEFAULT 'USD',
	"subtotal_cents" bigint DEFAULT 0,
	"discount_cents" bigint DEFAULT 0,
	"tax_cents" bigint DEFAULT 0,
	"shipping_cost_cents" bigint DEFAULT 0,
	"total_cents" bigint DEFAULT 0,
	"payment_terms_days" integer,
	"payment_terms_type" varchar(20),
	"shipping_method" varchar(50),
	"shipping_account_number" varchar(50),
	"incoterms" varchar(10),
	"freight_terms" varchar(30),
	"reference_number" varchar(100),
	"vendor_contact_name" varchar(100),
	"vendor_contact_email" varchar(255),
	"vendor_ack_date" timestamp,
	"vendor_ref_number" varchar(100),
	"line_count" integer DEFAULT 0,
	"received_line_count" integer DEFAULT 0,
	"revision_number" integer DEFAULT 0,
	"vendor_notes" text,
	"internal_notes" text,
	"approval_tier_id" integer,
	"approved_by" varchar,
	"approved_at" timestamp,
	"approval_notes" text,
	"sent_to_vendor_at" timestamp,
	"cancelled_at" timestamp,
	"cancelled_by" varchar,
	"cancel_reason" text,
	"closed_at" timestamp,
	"closed_by" varchar,
	"created_by" varchar,
	"updated_by" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"metadata" jsonb,
	CONSTRAINT "purchase_orders_po_number_unique" UNIQUE("po_number")
);
--> statement-breakpoint
CREATE TABLE "receiving_lines" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "receiving_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"receiving_order_id" integer NOT NULL,
	"product_variant_id" integer,
	"product_id" integer,
	"sku" varchar(100),
	"product_name" text,
	"barcode" varchar(100),
	"expected_qty" integer DEFAULT 0 NOT NULL,
	"received_qty" integer DEFAULT 0 NOT NULL,
	"damaged_qty" integer DEFAULT 0 NOT NULL,
	"purchase_order_line_id" integer,
	"unit_cost" double precision,
	"putaway_location_id" integer,
	"putaway_complete" integer DEFAULT 0 NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"received_by" varchar,
	"received_at" timestamp,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receiving_orders" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "receiving_orders_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"receipt_number" varchar(50) NOT NULL,
	"po_number" varchar(100),
	"purchase_order_id" integer,
	"asn_number" varchar(100),
	"inbound_shipment_id" integer,
	"source_type" varchar(20) DEFAULT 'blind' NOT NULL,
	"vendor_id" integer,
	"warehouse_id" integer,
	"receiving_location_id" integer,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"expected_date" timestamp,
	"received_date" timestamp,
	"closed_date" timestamp,
	"expected_line_count" integer DEFAULT 0,
	"received_line_count" integer DEFAULT 0,
	"expected_total_units" integer DEFAULT 0,
	"received_total_units" integer DEFAULT 0,
	"notes" text,
	"created_by" varchar(100),
	"received_by" varchar(100),
	"closed_by" varchar(100),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "receiving_orders_receipt_number_unique" UNIQUE("receipt_number")
);
--> statement-breakpoint
CREATE TABLE "vendor_invoice_attachments" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "vendor_invoice_attachments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"vendor_invoice_id" integer NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"file_type" varchar(100),
	"file_size_bytes" integer,
	"file_path" text NOT NULL,
	"uploaded_by" varchar,
	"uploaded_at" timestamp DEFAULT now() NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "vendor_invoice_lines" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "vendor_invoice_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"vendor_invoice_id" integer NOT NULL,
	"purchase_order_line_id" integer,
	"product_variant_id" integer,
	"line_number" integer NOT NULL,
	"sku" varchar(100),
	"product_name" text,
	"description" text,
	"qty_invoiced" integer NOT NULL,
	"qty_ordered" integer,
	"qty_received" integer,
	"unit_cost_cents" double precision NOT NULL,
	"line_total_cents" double precision NOT NULL,
	"match_status" varchar(20) DEFAULT 'pending' NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendor_invoice_po_links" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "vendor_invoice_po_links_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"vendor_invoice_id" integer NOT NULL,
	"purchase_order_id" integer NOT NULL,
	"allocated_amount_cents" bigint,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendor_invoices" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "vendor_invoices_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"invoice_number" varchar(100) NOT NULL,
	"our_reference" varchar(100),
	"vendor_id" integer NOT NULL,
	"inbound_shipment_id" integer,
	"status" varchar(20) DEFAULT 'received' NOT NULL,
	"invoice_date" timestamp,
	"received_date" timestamp,
	"due_date" timestamp,
	"approved_at" timestamp,
	"approved_by" varchar,
	"invoiced_amount_cents" bigint DEFAULT 0 NOT NULL,
	"paid_amount_cents" bigint DEFAULT 0 NOT NULL,
	"balance_cents" bigint DEFAULT 0 NOT NULL,
	"currency" varchar(3) DEFAULT 'USD',
	"payment_terms_days" integer,
	"payment_terms_type" varchar(20),
	"notes" text,
	"internal_notes" text,
	"dispute_reason" text,
	"created_by" varchar,
	"updated_by" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendor_products" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "vendor_products_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"vendor_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"product_variant_id" integer,
	"vendor_sku" varchar(100),
	"vendor_product_name" text,
	"unit_cost_cents" double precision DEFAULT 0,
	"pack_size" integer DEFAULT 1,
	"moq" integer DEFAULT 1,
	"lead_time_days" integer,
	"is_preferred" integer DEFAULT 0,
	"is_active" integer DEFAULT 1,
	"last_purchased_at" timestamp,
	"last_cost_cents" double precision,
	"weight_kg" numeric(10, 3),
	"length_cm" numeric(8, 2),
	"width_cm" numeric(8, 2),
	"height_cm" numeric(8, 2),
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "vendors_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"code" varchar(20) NOT NULL,
	"name" text NOT NULL,
	"contact_name" text,
	"email" varchar(255),
	"phone" varchar(50),
	"address" text,
	"notes" text,
	"active" integer DEFAULT 1 NOT NULL,
	"payment_terms_days" integer DEFAULT 30,
	"payment_terms_type" varchar(20) DEFAULT 'net',
	"currency" varchar(3) DEFAULT 'USD',
	"tax_id" varchar(50),
	"account_number" varchar(50),
	"website" text,
	"default_lead_time_days" integer DEFAULT 120,
	"minimum_order_cents" integer DEFAULT 0,
	"free_freight_threshold_cents" integer,
	"vendor_type" varchar(20) DEFAULT 'distributor',
	"ship_from_address" text,
	"country" varchar(50) DEFAULT 'US',
	"rating" integer,
	"default_incoterms" varchar(10),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "vendors_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "combined_order_groups" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "combined_order_groups_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"group_code" varchar(20) NOT NULL,
	"customer_name" text NOT NULL,
	"customer_email" text,
	"shipping_address" text,
	"shipping_city" text,
	"shipping_state" text,
	"shipping_postal_code" text,
	"shipping_country" text,
	"address_hash" varchar(64),
	"order_count" integer DEFAULT 0 NOT NULL,
	"total_items" integer DEFAULT 0 NOT NULL,
	"total_units" integer DEFAULT 0 NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_by" varchar,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "combined_order_groups_group_code_unique" UNIQUE("group_code")
);
--> statement-breakpoint
CREATE TABLE "fulfillment_routing_rules" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "fulfillment_routing_rules_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"channel_id" integer,
	"match_type" varchar(20) NOT NULL,
	"match_value" varchar(255),
	"warehouse_id" integer NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"is_active" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_item_costs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "order_item_costs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"order_id" integer NOT NULL,
	"order_item_id" integer NOT NULL,
	"inventory_lot_id" integer NOT NULL,
	"product_variant_id" integer NOT NULL,
	"qty" integer NOT NULL,
	"unit_cost_cents" double precision NOT NULL,
	"total_cost_cents" double precision NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_item_financials" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "order_item_financials_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"order_id" integer NOT NULL,
	"order_item_id" integer NOT NULL,
	"product_id" integer,
	"product_variant_id" integer,
	"sku" varchar(100),
	"product_name" text,
	"qty_shipped" integer NOT NULL,
	"revenue_cents" bigint NOT NULL,
	"cogs_cents" bigint NOT NULL,
	"gross_profit_cents" bigint NOT NULL,
	"margin_percent" numeric(5, 2),
	"avg_selling_price_cents" double precision,
	"avg_unit_cost_cents" double precision,
	"vendor_id" integer,
	"channel_id" integer,
	"shipped_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbound_shipment_items" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "outbound_shipment_items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"shipment_id" integer NOT NULL,
	"order_item_id" integer,
	"product_variant_id" integer,
	"qty" integer DEFAULT 1 NOT NULL,
	"from_location_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbound_shipments" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "outbound_shipments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"order_id" integer,
	"channel_id" integer,
	"external_fulfillment_id" varchar(200),
	"source" varchar(30) DEFAULT 'shopify_webhook' NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"carrier" varchar(100),
	"tracking_number" varchar(200),
	"tracking_url" text,
	"shipped_at" timestamp,
	"delivered_at" timestamp,
	"carrier_cost_cents" integer DEFAULT 0,
	"dunnage_cost_cents" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wms"."order_items" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "wms"."order_items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"wms_order_id" integer NOT NULL,
	"oms_order_line_id" integer,
	"product_id" integer,
	"sku" varchar(100) NOT NULL,
	"name" text NOT NULL,
	"image_url" text,
	"barcode" varchar(100),
	"customs_declared_value_cents" integer,
	"quantity" integer NOT NULL,
	"picked_quantity" integer DEFAULT 0 NOT NULL,
	"fulfilled_quantity" integer DEFAULT 0 NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"location" varchar(50) DEFAULT 'UNASSIGNED' NOT NULL,
	"zone" varchar(10) DEFAULT 'U' NOT NULL,
	"short_reason" text,
	"picked_at" timestamp,
	"requires_shipping" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wms"."orders" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "wms"."orders_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"oms_fulfillment_order_id" varchar(128),
	"channel_id" integer,
	"source" varchar(20) DEFAULT 'shopify' NOT NULL,
	"external_order_id" varchar(100),
	"order_number" varchar(50) NOT NULL,
	"customer_name" text NOT NULL,
	"customer_email" text,
	"shipping_name" text,
	"shipping_address" text,
	"shipping_city" text,
	"shipping_state" text,
	"shipping_postal_code" text,
	"shipping_country" text,
	"warehouse_id" integer,
	"priority" varchar(20) DEFAULT 'normal' NOT NULL,
	"warehouse_status" varchar(20) DEFAULT 'ready' NOT NULL,
	"on_hold" integer DEFAULT 0 NOT NULL,
	"held_at" timestamp,
	"assigned_picker_id" varchar(100),
	"batch_id" varchar(50),
	"combined_group_id" integer,
	"combined_role" varchar(20),
	"item_count" integer DEFAULT 0 NOT NULL,
	"unit_count" integer DEFAULT 0 NOT NULL,
	"picked_count" integer DEFAULT 0 NOT NULL,
	"order_placed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "cycle_count_items" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "cycle_count_items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"cycle_count_id" integer NOT NULL,
	"warehouse_location_id" integer NOT NULL,
	"product_variant_id" integer,
	"product_id" integer,
	"expected_sku" varchar(100),
	"expected_qty" integer DEFAULT 0 NOT NULL,
	"counted_sku" varchar(100),
	"counted_qty" integer,
	"variance_qty" integer,
	"variance_type" varchar(30),
	"variance_reason" varchar(50),
	"variance_notes" text,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"related_item_id" integer,
	"mismatch_type" varchar(20),
	"requires_approval" integer DEFAULT 0 NOT NULL,
	"approved_by" varchar(100),
	"approved_at" timestamp,
	"adjustment_transaction_id" integer,
	"resolved_by" varchar(100),
	"resolved_at" timestamp,
	"counted_by" varchar(100),
	"counted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cycle_counts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "cycle_counts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" varchar(100) NOT NULL,
	"description" text,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"warehouse_id" integer,
	"zone_filter" varchar(20),
	"aisle_filter" varchar(20),
	"location_type_filter" text,
	"bin_type_filter" text,
	"location_codes" text,
	"assigned_to" varchar(100),
	"total_bins" integer DEFAULT 0 NOT NULL,
	"counted_bins" integer DEFAULT 0 NOT NULL,
	"variance_count" integer DEFAULT 0 NOT NULL,
	"approved_variances" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_by" varchar(100),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_lots" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inventory_lots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"lot_number" varchar(50) NOT NULL,
	"product_variant_id" integer NOT NULL,
	"warehouse_location_id" integer NOT NULL,
	"receiving_order_id" integer,
	"purchase_order_id" integer,
	"unit_cost_cents" double precision DEFAULT 0 NOT NULL,
	"qty_on_hand" integer DEFAULT 0 NOT NULL,
	"qty_reserved" integer DEFAULT 0 NOT NULL,
	"qty_picked" integer DEFAULT 0 NOT NULL,
	"received_at" timestamp NOT NULL,
	"expiry_date" timestamp,
	"status" varchar(20) DEFAULT 'active',
	"inbound_shipment_id" integer,
	"cost_provisional" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "location_replen_config" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "location_replen_config_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"warehouse_location_id" integer NOT NULL,
	"product_variant_id" integer,
	"trigger_value" varchar(20),
	"max_qty" integer,
	"replen_method" varchar(30),
	"is_active" integer DEFAULT 1 NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "replen_rules" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "replen_rules_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"product_id" integer,
	"pick_product_variant_id" integer,
	"source_product_variant_id" integer,
	"pick_location_type" varchar(30),
	"source_location_type" varchar(30),
	"source_priority" varchar(20),
	"trigger_value" integer,
	"max_qty" integer,
	"replen_method" varchar(30),
	"priority" integer,
	"auto_replen" integer,
	"is_active" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "replen_tasks" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "replen_tasks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"replen_rule_id" integer,
	"from_location_id" integer NOT NULL,
	"to_location_id" integer NOT NULL,
	"product_id" integer,
	"source_product_variant_id" integer,
	"pick_product_variant_id" integer,
	"qty_source_units" integer DEFAULT 1 NOT NULL,
	"qty_target_units" integer NOT NULL,
	"qty_completed" integer DEFAULT 0 NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"priority" integer DEFAULT 5 NOT NULL,
	"triggered_by" varchar(20) DEFAULT 'min_max' NOT NULL,
	"execution_mode" varchar(20) DEFAULT 'queue' NOT NULL,
	"replen_method" varchar(30) DEFAULT 'full_case' NOT NULL,
	"auto_replen" integer DEFAULT 0 NOT NULL,
	"warehouse_id" integer,
	"created_by" varchar(100),
	"assigned_to" varchar(100),
	"assigned_at" timestamp,
	"started_at" timestamp,
	"completed_at" timestamp,
	"notes" text,
	"exception_reason" varchar(30),
	"linked_cycle_count_id" integer,
	"depends_on_task_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "replen_tier_defaults" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "replen_tier_defaults_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"warehouse_id" integer,
	"hierarchy_level" integer NOT NULL,
	"source_hierarchy_level" integer NOT NULL,
	"pick_location_type" varchar(30) DEFAULT 'pick' NOT NULL,
	"source_location_type" varchar(30) DEFAULT 'reserve' NOT NULL,
	"source_priority" varchar(20) DEFAULT 'fifo' NOT NULL,
	"trigger_value" integer DEFAULT 0 NOT NULL,
	"max_qty" integer,
	"replen_method" varchar(30) DEFAULT 'case_break' NOT NULL,
	"priority" integer DEFAULT 5 NOT NULL,
	"auto_replen" integer DEFAULT 0 NOT NULL,
	"is_active" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "warehouse_settings" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "warehouse_settings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"warehouse_id" integer,
	"warehouse_code" varchar(50) DEFAULT 'DEFAULT' NOT NULL,
	"warehouse_name" varchar(100) DEFAULT 'Main Warehouse' NOT NULL,
	"replen_mode" varchar(20) DEFAULT 'queue' NOT NULL,
	"short_pick_action" varchar(30) DEFAULT 'partial_pick' NOT NULL,
	"auto_generate_trigger" varchar(30) DEFAULT 'manual_only' NOT NULL,
	"inline_replen_max_units" integer DEFAULT 50,
	"inline_replen_max_cases" integer DEFAULT 2,
	"urgent_replen_threshold" integer DEFAULT 0,
	"stockout_priority" integer DEFAULT 1,
	"min_max_priority" integer DEFAULT 5,
	"scheduled_replen_interval_minutes" integer DEFAULT 30,
	"scheduled_replen_enabled" integer DEFAULT 0,
	"pick_path_optimization" varchar(30) DEFAULT 'zone_sequence',
	"max_orders_per_wave" integer DEFAULT 50,
	"max_items_per_wave" integer DEFAULT 500,
	"wave_auto_release" integer DEFAULT 0,
	"enable_order_combining" integer DEFAULT 1 NOT NULL,
	"channel_sync_enabled" integer DEFAULT 0 NOT NULL,
	"channel_sync_interval_minutes" integer DEFAULT 15 NOT NULL,
	"velocity_lookback_days" integer DEFAULT 14 NOT NULL,
	"post_pick_status" varchar(30) DEFAULT 'ready_to_ship' NOT NULL,
	"pick_mode" varchar(20) DEFAULT 'single_order' NOT NULL,
	"require_scan_confirm" integer DEFAULT 0 NOT NULL,
	"picking_batch_size" integer DEFAULT 20 NOT NULL,
	"auto_release_delay_minutes" integer DEFAULT 30 NOT NULL,
	"is_active" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "warehouse_settings_warehouse_code_unique" UNIQUE("warehouse_code")
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notification_preferences_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"notification_type_id" integer NOT NULL,
	"role_id" integer,
	"user_id" varchar,
	"enabled" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_types" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notification_types_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"key" varchar(100) NOT NULL,
	"label" varchar(200) NOT NULL,
	"description" text,
	"category" varchar(50) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "notification_types_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notifications_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" varchar NOT NULL,
	"notification_type_id" integer NOT NULL,
	"title" varchar(300) NOT NULL,
	"message" text,
	"data" jsonb,
	"read" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ebay_category_mappings" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ebay_category_mappings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"channel_id" integer NOT NULL,
	"product_type_slug" varchar(50) NOT NULL,
	"ebay_browse_category_id" varchar(20),
	"ebay_browse_category_name" varchar(200),
	"ebay_store_category_id" varchar(20),
	"ebay_store_category_name" varchar(200),
	"fulfillment_policy_override" varchar(20),
	"return_policy_override" varchar(20),
	"payment_policy_override" varchar(20),
	"listing_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ebay_listing_rules" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ebay_listing_rules_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"channel_id" integer NOT NULL,
	"scope_type" varchar(20) NOT NULL,
	"scope_value" varchar(100),
	"ebay_category_id" varchar(20),
	"ebay_store_category_id" varchar(20),
	"fulfillment_policy_id" varchar(20),
	"return_policy_id" varchar(20),
	"payment_policy_id" varchar(20),
	"sort_order" integer DEFAULT 0,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ebay_oauth_tokens" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ebay_oauth_tokens_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"channel_id" integer NOT NULL,
	"environment" varchar(20) DEFAULT 'production' NOT NULL,
	"access_token" text NOT NULL,
	"access_token_expires_at" timestamp NOT NULL,
	"refresh_token" text NOT NULL,
	"refresh_token_expires_at" timestamp,
	"scopes" text,
	"last_refreshed_at" timestamp DEFAULT now(),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oms"."oms_order_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "oms"."oms_order_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"order_id" bigint NOT NULL,
	"event_type" varchar(50) NOT NULL,
	"details" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oms"."oms_order_lines" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "oms"."oms_order_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"order_id" bigint NOT NULL,
	"product_variant_id" integer,
	"external_line_item_id" varchar(100),
	"external_product_id" varchar(100),
	"sku" varchar(100),
	"title" varchar(300),
	"variant_title" varchar(200),
	"name" text,
	"vendor" varchar(200),
	"quantity" integer NOT NULL,
	"paid_price_cents" integer DEFAULT 0 NOT NULL,
	"total_price_cents" integer DEFAULT 0 NOT NULL,
	"total_discount_cents" integer DEFAULT 0 NOT NULL,
	"plan_discount_cents" integer DEFAULT 0 NOT NULL,
	"coupon_discount_cents" integer DEFAULT 0 NOT NULL,
	"discount_allocations" jsonb,
	"taxable" boolean DEFAULT true,
	"tax_lines" jsonb,
	"requires_shipping" boolean DEFAULT true,
	"gift_card" boolean DEFAULT false,
	"product_exists" boolean DEFAULT true,
	"fulfillable_quantity" integer,
	"fulfillment_service" varchar(100),
	"fulfillment_status" varchar(30) DEFAULT 'unfulfilled',
	"properties" jsonb,
	"compare_at_price_cents" integer,
	"order_number" varchar(50),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "oms"."oms_orders" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "oms"."oms_orders_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"channel_id" integer NOT NULL,
	"external_order_id" varchar(100) NOT NULL,
	"external_order_number" varchar(50),
	"status" varchar(30) DEFAULT 'pending' NOT NULL,
	"financial_status" varchar(30) DEFAULT 'paid',
	"fulfillment_status" varchar(30) DEFAULT 'unfulfilled',
	"customer_name" varchar(200),
	"customer_email" varchar(200),
	"customer_phone" varchar(50),
	"ship_to_name" varchar(200),
	"ship_to_address1" varchar(300),
	"ship_to_address2" varchar(300),
	"ship_to_city" varchar(100),
	"ship_to_state" varchar(100),
	"ship_to_zip" varchar(20),
	"ship_to_country" varchar(100),
	"subtotal_cents" integer DEFAULT 0 NOT NULL,
	"shipping_cents" integer DEFAULT 0 NOT NULL,
	"tax_cents" integer DEFAULT 0 NOT NULL,
	"discount_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer DEFAULT 0 NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"warehouse_id" integer,
	"tracking_number" varchar(100),
	"tracking_carrier" varchar(50),
	"shipped_at" timestamp,
	"cancelled_at" timestamp,
	"refunded_at" timestamp,
	"shipstation_order_id" integer,
	"shipstation_order_key" varchar(100),
	"member_tier" varchar(50),
	"raw_payload" jsonb,
	"notes" text,
	"tags" text,
	"ordered_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "catalog_assets" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "catalog_products" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "inventory_items" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "uom_variants" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "catalog_assets" CASCADE;--> statement-breakpoint
DROP TABLE "catalog_products" CASCADE;--> statement-breakpoint
DROP TABLE "inventory_items" CASCADE;--> statement-breakpoint
DROP TABLE "uom_variants" CASCADE;--> statement-breakpoint
ALTER TABLE "product_locations" DROP CONSTRAINT "product_locations_sku_unique";--> statement-breakpoint
ALTER TABLE "warehouse_locations" DROP CONSTRAINT "warehouse_locations_code_unique";--> statement-breakpoint
ALTER TABLE "channel_asset_overrides" DROP CONSTRAINT "channel_asset_overrides_catalog_asset_id_catalog_assets_id_fk";
--> statement-breakpoint
ALTER TABLE "channel_feeds" DROP CONSTRAINT "channel_feeds_variant_id_uom_variants_id_fk";
--> statement-breakpoint
ALTER TABLE "channel_listings" DROP CONSTRAINT "channel_listings_variant_id_uom_variants_id_fk";
--> statement-breakpoint
ALTER TABLE "channel_pricing" DROP CONSTRAINT "channel_pricing_variant_id_uom_variants_id_fk";
--> statement-breakpoint
ALTER TABLE "channel_product_overrides" DROP CONSTRAINT "channel_product_overrides_catalog_product_id_catalog_products_id_fk";
--> statement-breakpoint
ALTER TABLE "channel_reservations" DROP CONSTRAINT "channel_reservations_inventory_item_id_inventory_items_id_fk";
--> statement-breakpoint
ALTER TABLE "channel_variant_overrides" DROP CONSTRAINT "channel_variant_overrides_variant_id_uom_variants_id_fk";
--> statement-breakpoint
ALTER TABLE "inventory_levels" DROP CONSTRAINT "inventory_levels_inventory_item_id_inventory_items_id_fk";
--> statement-breakpoint
ALTER TABLE "inventory_levels" DROP CONSTRAINT "inventory_levels_variant_id_uom_variants_id_fk";
--> statement-breakpoint
ALTER TABLE "inventory_transactions" DROP CONSTRAINT "inventory_transactions_inventory_item_id_inventory_items_id_fk";
--> statement-breakpoint
ALTER TABLE "inventory_transactions" DROP CONSTRAINT "inventory_transactions_variant_id_uom_variants_id_fk";
--> statement-breakpoint
ALTER TABLE "inventory_transactions" DROP CONSTRAINT "inventory_transactions_warehouse_location_id_warehouse_locations_id_fk";
--> statement-breakpoint
DROP INDEX "channel_listings_channel_variant_idx";--> statement-breakpoint
DROP INDEX "channel_pricing_channel_variant_idx";--> statement-breakpoint
DROP INDEX "channel_reservations_channel_item_idx";--> statement-breakpoint
DROP INDEX "channel_variant_overrides_channel_variant_idx";--> statement-breakpoint
DROP INDEX "channel_asset_overrides_channel_asset_idx";--> statement-breakpoint
DROP INDEX "channel_product_overrides_channel_product_idx";--> statement-breakpoint
ALTER TABLE "app_settings" ALTER COLUMN "type" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "app_settings" ALTER COLUMN "type" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app_settings" ALTER COLUMN "category" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "app_settings" ALTER COLUMN "category" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app_settings" ALTER COLUMN "updated_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ALTER COLUMN "variant_qty_delta" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ALTER COLUMN "variant_qty_delta" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "product_locations" ALTER COLUMN "sku" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "warehouse_locations" ALTER COLUMN "location_type" SET DEFAULT 'pick';--> statement-breakpoint
ALTER TABLE "warehouse_zones" ALTER COLUMN "location_type" SET DEFAULT 'pick';--> statement-breakpoint
ALTER TABLE "channel_asset_overrides" ADD COLUMN "product_asset_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_connections" ADD COLUMN "shopify_location_id" varchar(50);--> statement-breakpoint
ALTER TABLE "channel_feeds" ADD COLUMN "channel_id" integer;--> statement-breakpoint
ALTER TABLE "channel_feeds" ADD COLUMN "product_variant_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_feeds" ADD COLUMN "channel_inventory_item_id" varchar(100);--> statement-breakpoint
ALTER TABLE "channel_listings" ADD COLUMN "product_variant_id" integer;--> statement-breakpoint
ALTER TABLE "channel_pricing" ADD COLUMN "product_variant_id" integer;--> statement-breakpoint
ALTER TABLE "channel_product_overrides" ADD COLUMN "product_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_product_overrides" ADD COLUMN "item_specifics" jsonb;--> statement-breakpoint
ALTER TABLE "channel_product_overrides" ADD COLUMN "marketplace_category_id" varchar(100);--> statement-breakpoint
ALTER TABLE "channel_product_overrides" ADD COLUMN "listing_format" varchar(30);--> statement-breakpoint
ALTER TABLE "channel_product_overrides" ADD COLUMN "condition_id" integer;--> statement-breakpoint
ALTER TABLE "channel_reservations" ADD COLUMN "product_variant_id" integer;--> statement-breakpoint
ALTER TABLE "channel_reservations" ADD COLUMN "override_qty" integer;--> statement-breakpoint
ALTER TABLE "channel_variant_overrides" ADD COLUMN "product_variant_id" integer;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "allocation_pct" integer;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "allocation_fixed_qty" integer;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "sync_enabled" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "sync_mode" varchar(10) DEFAULT 'dry_run';--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "sweep_interval_minutes" integer DEFAULT 15;--> statement-breakpoint
ALTER TABLE "inventory_levels" ADD COLUMN "product_variant_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_levels" ADD COLUMN "reserved_qty" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_levels" ADD COLUMN "picked_qty" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_levels" ADD COLUMN "packed_qty" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_levels" ADD COLUMN "backorder_qty" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD COLUMN "product_variant_id" integer;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD COLUMN "from_location_id" integer;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD COLUMN "to_location_id" integer;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD COLUMN "unit_cost_cents" double precision;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD COLUMN "inventory_lot_id" integer;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD COLUMN "receiving_order_id" integer;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD COLUMN "cycle_count_id" integer;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD COLUMN "shipment_id" integer;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "product_id" integer;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "price_cents" integer;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "discount_cents" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "total_price_cents" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shipping_name" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "financial_status" varchar(30);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shopify_fulfillment_status" varchar(30);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "cancelled_at" timestamp;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "warehouse_id" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "warehouse_status" varchar(20) DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "combined_group_id" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "combined_role" varchar(20);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "legacy_order_id" varchar(100);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "sla_due_at" timestamp;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "sla_status" varchar(20);--> statement-breakpoint
ALTER TABLE "picking_logs" ADD COLUMN "product_id" integer;--> statement-breakpoint
ALTER TABLE "product_locations" ADD COLUMN "product_id" integer;--> statement-breakpoint
ALTER TABLE "product_locations" ADD COLUMN "shopify_variant_id" bigint;--> statement-breakpoint
ALTER TABLE "product_locations" ADD COLUMN "product_variant_id" integer;--> statement-breakpoint
ALTER TABLE "product_locations" ADD COLUMN "is_primary" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "warehouse_locations" ADD COLUMN "bin_type" varchar(30) DEFAULT 'bin' NOT NULL;--> statement-breakpoint
ALTER TABLE "warehouse_locations" ADD COLUMN "cycle_count_freeze_id" integer;--> statement-breakpoint
ALTER TABLE "warehouse_locations" ADD COLUMN "replen_source_type" varchar(30);--> statement-breakpoint
ALTER TABLE "warehouse_locations" ADD COLUMN "capacity_cubic_mm" bigint;--> statement-breakpoint
ALTER TABLE "warehouse_locations" ADD COLUMN "max_weight_g" integer;--> statement-breakpoint
ALTER TABLE "warehouse_locations" ADD COLUMN "width_mm" integer;--> statement-breakpoint
ALTER TABLE "warehouse_locations" ADD COLUMN "height_mm" integer;--> statement-breakpoint
ALTER TABLE "warehouse_locations" ADD COLUMN "depth_mm" integer;--> statement-breakpoint
ALTER TABLE "warehouse_locations" ADD COLUMN "is_active" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "warehouses" ADD COLUMN "warehouse_type" varchar(30) DEFAULT 'operations' NOT NULL;--> statement-breakpoint
ALTER TABLE "warehouses" ADD COLUMN "shopify_location_id" varchar(50);--> statement-breakpoint
ALTER TABLE "warehouses" ADD COLUMN "inventory_source_type" varchar(20) DEFAULT 'internal' NOT NULL;--> statement-breakpoint
ALTER TABLE "warehouses" ADD COLUMN "inventory_source_config" jsonb;--> statement-breakpoint
ALTER TABLE "warehouses" ADD COLUMN "last_inventory_sync_at" timestamp;--> statement-breakpoint
ALTER TABLE "warehouses" ADD COLUMN "inventory_sync_status" varchar(20) DEFAULT 'never';--> statement-breakpoint
ALTER TABLE "warehouses" ADD COLUMN "feed_enabled" boolean DEFAULT true;--> statement-breakpoint
ALTER TABLE "user_audit" ADD CONSTRAINT "user_audit_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_audit" ADD CONSTRAINT "user_audit_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_assets" ADD CONSTRAINT "product_assets_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_assets" ADD CONSTRAINT "product_assets_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_line_products" ADD CONSTRAINT "product_line_products_product_line_id_product_lines_id_fk" FOREIGN KEY ("product_line_id") REFERENCES "public"."product_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_line_products" ADD CONSTRAINT "product_line_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_audit_log" ADD CONSTRAINT "allocation_audit_log_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_audit_log" ADD CONSTRAINT "allocation_audit_log_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_audit_log" ADD CONSTRAINT "allocation_audit_log_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_allocation_rules" ADD CONSTRAINT "channel_allocation_rules_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_allocation_rules" ADD CONSTRAINT "channel_allocation_rules_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_allocation_rules" ADD CONSTRAINT "channel_allocation_rules_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_product_allocation" ADD CONSTRAINT "channel_product_allocation_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_product_allocation" ADD CONSTRAINT "channel_product_allocation_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_product_lines" ADD CONSTRAINT "channel_product_lines_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_product_lines" ADD CONSTRAINT "channel_product_lines_product_line_id_product_lines_id_fk" FOREIGN KEY ("product_line_id") REFERENCES "public"."product_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_sync_log" ADD CONSTRAINT "channel_sync_log_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_sync_log" ADD CONSTRAINT "channel_sync_log_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_sync_log" ADD CONSTRAINT "channel_sync_log_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_sync_log" ADD CONSTRAINT "channel_sync_log_channel_feed_id_channel_feeds_id_fk" FOREIGN KEY ("channel_feed_id") REFERENCES "public"."channel_feeds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_warehouse_assignments" ADD CONSTRAINT "channel_warehouse_assignments_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_lock_config" ADD CONSTRAINT "source_lock_config_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_log" ADD CONSTRAINT "sync_log_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_payment_allocations" ADD CONSTRAINT "ap_payment_allocations_ap_payment_id_ap_payments_id_fk" FOREIGN KEY ("ap_payment_id") REFERENCES "public"."ap_payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_payment_allocations" ADD CONSTRAINT "ap_payment_allocations_vendor_invoice_id_vendor_invoices_id_fk" FOREIGN KEY ("vendor_invoice_id") REFERENCES "public"."vendor_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_payments" ADD CONSTRAINT "ap_payments_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_payments" ADD CONSTRAINT "ap_payments_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_payments" ADD CONSTRAINT "ap_payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_payments" ADD CONSTRAINT "ap_payments_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_freight_allocations" ADD CONSTRAINT "inbound_freight_allocations_shipment_cost_id_inbound_freight_costs_id_fk" FOREIGN KEY ("shipment_cost_id") REFERENCES "public"."inbound_freight_costs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_freight_allocations" ADD CONSTRAINT "inbound_freight_allocations_inbound_shipment_line_id_inbound_shipment_lines_id_fk" FOREIGN KEY ("inbound_shipment_line_id") REFERENCES "public"."inbound_shipment_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_freight_costs" ADD CONSTRAINT "inbound_freight_costs_inbound_shipment_id_inbound_shipments_id_fk" FOREIGN KEY ("inbound_shipment_id") REFERENCES "public"."inbound_shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_freight_costs" ADD CONSTRAINT "inbound_freight_costs_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_freight_costs" ADD CONSTRAINT "inbound_freight_costs_vendor_invoice_id_vendor_invoices_id_fk" FOREIGN KEY ("vendor_invoice_id") REFERENCES "public"."vendor_invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_shipment_lines" ADD CONSTRAINT "inbound_shipment_lines_inbound_shipment_id_inbound_shipments_id_fk" FOREIGN KEY ("inbound_shipment_id") REFERENCES "public"."inbound_shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_shipment_lines" ADD CONSTRAINT "inbound_shipment_lines_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_shipment_lines" ADD CONSTRAINT "inbound_shipment_lines_purchase_order_line_id_purchase_order_lines_id_fk" FOREIGN KEY ("purchase_order_line_id") REFERENCES "public"."purchase_order_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_shipment_lines" ADD CONSTRAINT "inbound_shipment_lines_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_shipment_status_history" ADD CONSTRAINT "inbound_shipment_status_history_inbound_shipment_id_inbound_shipments_id_fk" FOREIGN KEY ("inbound_shipment_id") REFERENCES "public"."inbound_shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_shipment_status_history" ADD CONSTRAINT "inbound_shipment_status_history_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_shipments" ADD CONSTRAINT "inbound_shipments_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_shipments" ADD CONSTRAINT "inbound_shipments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_shipments" ADD CONSTRAINT "inbound_shipments_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_cost_snapshots" ADD CONSTRAINT "landed_cost_snapshots_inbound_shipment_line_id_inbound_shipment_lines_id_fk" FOREIGN KEY ("inbound_shipment_line_id") REFERENCES "public"."inbound_shipment_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_cost_snapshots" ADD CONSTRAINT "landed_cost_snapshots_purchase_order_line_id_purchase_order_lines_id_fk" FOREIGN KEY ("purchase_order_line_id") REFERENCES "public"."purchase_order_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landed_cost_snapshots" ADD CONSTRAINT "landed_cost_snapshots_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_receipts" ADD CONSTRAINT "po_receipts_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_receipts" ADD CONSTRAINT "po_receipts_purchase_order_line_id_purchase_order_lines_id_fk" FOREIGN KEY ("purchase_order_line_id") REFERENCES "public"."purchase_order_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_receipts" ADD CONSTRAINT "po_receipts_receiving_order_id_receiving_orders_id_fk" FOREIGN KEY ("receiving_order_id") REFERENCES "public"."receiving_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_receipts" ADD CONSTRAINT "po_receipts_receiving_line_id_receiving_lines_id_fk" FOREIGN KEY ("receiving_line_id") REFERENCES "public"."receiving_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_revisions" ADD CONSTRAINT "po_revisions_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_revisions" ADD CONSTRAINT "po_revisions_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_revisions" ADD CONSTRAINT "po_revisions_line_id_purchase_order_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."purchase_order_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_status_history" ADD CONSTRAINT "po_status_history_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_status_history" ADD CONSTRAINT "po_status_history_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_vendor_product_id_vendor_products_id_fk" FOREIGN KEY ("vendor_product_id") REFERENCES "public"."vendor_products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_approval_tier_id_po_approval_tiers_id_fk" FOREIGN KEY ("approval_tier_id") REFERENCES "public"."po_approval_tiers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_lines" ADD CONSTRAINT "receiving_lines_receiving_order_id_receiving_orders_id_fk" FOREIGN KEY ("receiving_order_id") REFERENCES "public"."receiving_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_lines" ADD CONSTRAINT "receiving_lines_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_lines" ADD CONSTRAINT "receiving_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_lines" ADD CONSTRAINT "receiving_lines_putaway_location_id_warehouse_locations_id_fk" FOREIGN KEY ("putaway_location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_lines" ADD CONSTRAINT "receiving_lines_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_orders" ADD CONSTRAINT "receiving_orders_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_orders" ADD CONSTRAINT "receiving_orders_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_orders" ADD CONSTRAINT "receiving_orders_receiving_location_id_warehouse_locations_id_fk" FOREIGN KEY ("receiving_location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_invoice_attachments" ADD CONSTRAINT "vendor_invoice_attachments_vendor_invoice_id_vendor_invoices_id_fk" FOREIGN KEY ("vendor_invoice_id") REFERENCES "public"."vendor_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_invoice_attachments" ADD CONSTRAINT "vendor_invoice_attachments_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_invoice_lines" ADD CONSTRAINT "vendor_invoice_lines_vendor_invoice_id_vendor_invoices_id_fk" FOREIGN KEY ("vendor_invoice_id") REFERENCES "public"."vendor_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_invoice_lines" ADD CONSTRAINT "vendor_invoice_lines_purchase_order_line_id_purchase_order_lines_id_fk" FOREIGN KEY ("purchase_order_line_id") REFERENCES "public"."purchase_order_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_invoice_lines" ADD CONSTRAINT "vendor_invoice_lines_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_invoice_po_links" ADD CONSTRAINT "vendor_invoice_po_links_vendor_invoice_id_vendor_invoices_id_fk" FOREIGN KEY ("vendor_invoice_id") REFERENCES "public"."vendor_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_invoice_po_links" ADD CONSTRAINT "vendor_invoice_po_links_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_invoices" ADD CONSTRAINT "vendor_invoices_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_invoices" ADD CONSTRAINT "vendor_invoices_inbound_shipment_id_inbound_shipments_id_fk" FOREIGN KEY ("inbound_shipment_id") REFERENCES "public"."inbound_shipments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_invoices" ADD CONSTRAINT "vendor_invoices_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_invoices" ADD CONSTRAINT "vendor_invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_invoices" ADD CONSTRAINT "vendor_invoices_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_products" ADD CONSTRAINT "vendor_products_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_products" ADD CONSTRAINT "vendor_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_products" ADD CONSTRAINT "vendor_products_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "combined_order_groups" ADD CONSTRAINT "combined_order_groups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_routing_rules" ADD CONSTRAINT "fulfillment_routing_rules_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_routing_rules" ADD CONSTRAINT "fulfillment_routing_rules_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_costs" ADD CONSTRAINT "order_item_costs_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_costs" ADD CONSTRAINT "order_item_costs_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_costs" ADD CONSTRAINT "order_item_costs_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_financials" ADD CONSTRAINT "order_item_financials_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_financials" ADD CONSTRAINT "order_item_financials_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_financials" ADD CONSTRAINT "order_item_financials_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_financials" ADD CONSTRAINT "order_item_financials_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_financials" ADD CONSTRAINT "order_item_financials_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_financials" ADD CONSTRAINT "order_item_financials_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_shipment_items" ADD CONSTRAINT "outbound_shipment_items_shipment_id_outbound_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."outbound_shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_shipment_items" ADD CONSTRAINT "outbound_shipment_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_shipment_items" ADD CONSTRAINT "outbound_shipment_items_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_shipment_items" ADD CONSTRAINT "outbound_shipment_items_from_location_id_warehouse_locations_id_fk" FOREIGN KEY ("from_location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_shipments" ADD CONSTRAINT "outbound_shipments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_shipments" ADD CONSTRAINT "outbound_shipments_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."order_items" ADD CONSTRAINT "order_items_wms_order_id_orders_id_fk" FOREIGN KEY ("wms_order_id") REFERENCES "wms"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."orders" ADD CONSTRAINT "orders_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wms"."orders" ADD CONSTRAINT "orders_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_count_items" ADD CONSTRAINT "cycle_count_items_cycle_count_id_cycle_counts_id_fk" FOREIGN KEY ("cycle_count_id") REFERENCES "public"."cycle_counts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_count_items" ADD CONSTRAINT "cycle_count_items_warehouse_location_id_warehouse_locations_id_fk" FOREIGN KEY ("warehouse_location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_count_items" ADD CONSTRAINT "cycle_count_items_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_count_items" ADD CONSTRAINT "cycle_count_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_count_items" ADD CONSTRAINT "cycle_count_items_adjustment_transaction_id_inventory_transactions_id_fk" FOREIGN KEY ("adjustment_transaction_id") REFERENCES "public"."inventory_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_counts" ADD CONSTRAINT "cycle_counts_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_warehouse_location_id_warehouse_locations_id_fk" FOREIGN KEY ("warehouse_location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_receiving_order_id_receiving_orders_id_fk" FOREIGN KEY ("receiving_order_id") REFERENCES "public"."receiving_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_lots" ADD CONSTRAINT "inventory_lots_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_replen_config" ADD CONSTRAINT "location_replen_config_warehouse_location_id_warehouse_locations_id_fk" FOREIGN KEY ("warehouse_location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_replen_config" ADD CONSTRAINT "location_replen_config_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replen_rules" ADD CONSTRAINT "replen_rules_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replen_rules" ADD CONSTRAINT "replen_rules_pick_product_variant_id_product_variants_id_fk" FOREIGN KEY ("pick_product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replen_rules" ADD CONSTRAINT "replen_rules_source_product_variant_id_product_variants_id_fk" FOREIGN KEY ("source_product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replen_tasks" ADD CONSTRAINT "replen_tasks_replen_rule_id_replen_rules_id_fk" FOREIGN KEY ("replen_rule_id") REFERENCES "public"."replen_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replen_tasks" ADD CONSTRAINT "replen_tasks_from_location_id_warehouse_locations_id_fk" FOREIGN KEY ("from_location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replen_tasks" ADD CONSTRAINT "replen_tasks_to_location_id_warehouse_locations_id_fk" FOREIGN KEY ("to_location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replen_tasks" ADD CONSTRAINT "replen_tasks_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replen_tasks" ADD CONSTRAINT "replen_tasks_source_product_variant_id_product_variants_id_fk" FOREIGN KEY ("source_product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replen_tasks" ADD CONSTRAINT "replen_tasks_pick_product_variant_id_product_variants_id_fk" FOREIGN KEY ("pick_product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replen_tasks" ADD CONSTRAINT "replen_tasks_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replen_tasks" ADD CONSTRAINT "replen_tasks_linked_cycle_count_id_cycle_counts_id_fk" FOREIGN KEY ("linked_cycle_count_id") REFERENCES "public"."cycle_counts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replen_tier_defaults" ADD CONSTRAINT "replen_tier_defaults_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_settings" ADD CONSTRAINT "warehouse_settings_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_notification_type_id_notification_types_id_fk" FOREIGN KEY ("notification_type_id") REFERENCES "public"."notification_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_role_id_auth_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."auth_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_notification_type_id_notification_types_id_fk" FOREIGN KEY ("notification_type_id") REFERENCES "public"."notification_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ebay_category_mappings" ADD CONSTRAINT "ebay_category_mappings_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ebay_listing_rules" ADD CONSTRAINT "ebay_listing_rules_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ebay_oauth_tokens" ADD CONSTRAINT "ebay_oauth_tokens_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oms"."oms_order_events" ADD CONSTRAINT "oms_order_events_order_id_oms_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "oms"."oms_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oms"."oms_order_lines" ADD CONSTRAINT "oms_order_lines_order_id_oms_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "oms"."oms_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oms"."oms_order_lines" ADD CONSTRAINT "oms_order_lines_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oms"."oms_orders" ADD CONSTRAINT "oms_orders_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oms"."oms_orders" ADD CONSTRAINT "oms_orders_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plp_line_product_idx" ON "product_line_products" USING btree ("product_line_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "car_channel_product_variant_idx" ON "channel_allocation_rules" USING btree (COALESCE("channel_id", 0),COALESCE("product_id", 0),COALESCE("product_variant_id", 0));--> statement-breakpoint
CREATE UNIQUE INDEX "channel_product_alloc_channel_product_idx" ON "channel_product_allocation" USING btree ("channel_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cpl_channel_line_idx" ON "channel_product_lines" USING btree ("channel_id","product_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cwa_channel_warehouse_idx" ON "channel_warehouse_assignments" USING btree ("channel_id","warehouse_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_lock_config_channel_field_idx" ON "source_lock_config" USING btree ("channel_id","field_type");--> statement-breakpoint
CREATE INDEX "idx_sync_log_channel" ON "sync_log" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "idx_sync_log_created" ON "sync_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_sync_log_status" ON "sync_log" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "ap_payment_allocations_pay_inv_idx" ON "ap_payment_allocations" USING btree ("ap_payment_id","vendor_invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "po_receipts_po_line_rcv_line_idx" ON "po_receipts" USING btree ("purchase_order_line_id","receiving_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_invoice_po_links_inv_po_idx" ON "vendor_invoice_po_links" USING btree ("vendor_invoice_id","purchase_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_products_vendor_product_variant_idx" ON "vendor_products" USING btree ("vendor_id","product_id","product_variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_pref_type_role_user_idx" ON "notification_preferences" USING btree ("notification_type_id","role_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ebay_cat_map_channel_type_idx" ON "ebay_category_mappings" USING btree ("channel_id","product_type_slug");--> statement-breakpoint
CREATE UNIQUE INDEX "ebay_listing_rules_channel_scope_idx" ON "ebay_listing_rules" USING btree ("channel_id","scope_type","scope_value");--> statement-breakpoint
CREATE UNIQUE INDEX "ebay_oauth_tokens_channel_env_idx" ON "ebay_oauth_tokens" USING btree ("channel_id","environment");--> statement-breakpoint
CREATE INDEX "idx_oms_events_order" ON "oms"."oms_order_events" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "idx_oms_lines_order" ON "oms"."oms_order_lines" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "idx_oms_lines_variant" ON "oms"."oms_order_lines" USING btree ("product_variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oms_orders_channel_external_idx" ON "oms"."oms_orders" USING btree ("channel_id","external_order_id");--> statement-breakpoint
CREATE INDEX "idx_oms_orders_status" ON "oms"."oms_orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_oms_orders_channel" ON "oms"."oms_orders" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "idx_oms_orders_ordered" ON "oms"."oms_orders" USING btree ("ordered_at");--> statement-breakpoint
CREATE INDEX "idx_oms_orders_external" ON "oms"."oms_orders" USING btree ("external_order_id");--> statement-breakpoint
ALTER TABLE "channel_asset_overrides" ADD CONSTRAINT "channel_asset_overrides_product_asset_id_product_assets_id_fk" FOREIGN KEY ("product_asset_id") REFERENCES "public"."product_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_feeds" ADD CONSTRAINT "channel_feeds_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_feeds" ADD CONSTRAINT "channel_feeds_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_listings" ADD CONSTRAINT "channel_listings_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_pricing" ADD CONSTRAINT "channel_pricing_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_product_overrides" ADD CONSTRAINT "channel_product_overrides_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_reservations" ADD CONSTRAINT "channel_reservations_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_variant_overrides" ADD CONSTRAINT "channel_variant_overrides_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_levels" ADD CONSTRAINT "inventory_levels_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_from_location_id_warehouse_locations_id_fk" FOREIGN KEY ("from_location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_to_location_id_warehouse_locations_id_fk" FOREIGN KEY ("to_location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_receiving_order_id_receiving_orders_id_fk" FOREIGN KEY ("receiving_order_id") REFERENCES "public"."receiving_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_cycle_count_id_cycle_counts_id_fk" FOREIGN KEY ("cycle_count_id") REFERENCES "public"."cycle_counts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_shipment_id_outbound_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."outbound_shipments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_locations" ADD CONSTRAINT "product_locations_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "public"."product_variants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_listings_channel_pv_idx" ON "channel_listings" USING btree ("channel_id","product_variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_pricing_channel_pv_idx" ON "channel_pricing" USING btree ("channel_id","product_variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_reservations_channel_pv_idx" ON "channel_reservations" USING btree ("channel_id","product_variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_variant_overrides_channel_pv_idx" ON "channel_variant_overrides" USING btree ("channel_id","product_variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_asset_overrides_channel_asset_idx" ON "channel_asset_overrides" USING btree ("channel_id","product_asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_product_overrides_channel_product_idx" ON "channel_product_overrides" USING btree ("channel_id","product_id");--> statement-breakpoint
ALTER TABLE "channel_asset_overrides" DROP COLUMN "catalog_asset_id";--> statement-breakpoint
ALTER TABLE "channel_feeds" DROP COLUMN "variant_id";--> statement-breakpoint
ALTER TABLE "channel_listings" DROP COLUMN "variant_id";--> statement-breakpoint
ALTER TABLE "channel_pricing" DROP COLUMN "variant_id";--> statement-breakpoint
ALTER TABLE "channel_product_overrides" DROP COLUMN "catalog_product_id";--> statement-breakpoint
ALTER TABLE "channel_reservations" DROP COLUMN "inventory_item_id";--> statement-breakpoint
ALTER TABLE "channel_variant_overrides" DROP COLUMN "variant_id";--> statement-breakpoint
ALTER TABLE "inventory_levels" DROP COLUMN "inventory_item_id";--> statement-breakpoint
ALTER TABLE "inventory_levels" DROP COLUMN "variant_id";--> statement-breakpoint
ALTER TABLE "inventory_levels" DROP COLUMN "on_hand_base";--> statement-breakpoint
ALTER TABLE "inventory_levels" DROP COLUMN "reserved_base";--> statement-breakpoint
ALTER TABLE "inventory_levels" DROP COLUMN "picked_base";--> statement-breakpoint
ALTER TABLE "inventory_levels" DROP COLUMN "packed_base";--> statement-breakpoint
ALTER TABLE "inventory_levels" DROP COLUMN "backorder_base";--> statement-breakpoint
ALTER TABLE "inventory_transactions" DROP COLUMN "inventory_item_id";--> statement-breakpoint
ALTER TABLE "inventory_transactions" DROP COLUMN "variant_id";--> statement-breakpoint
ALTER TABLE "inventory_transactions" DROP COLUMN "warehouse_location_id";--> statement-breakpoint
ALTER TABLE "inventory_transactions" DROP COLUMN "base_qty_delta";--> statement-breakpoint
ALTER TABLE "inventory_transactions" DROP COLUMN "base_qty_before";--> statement-breakpoint
ALTER TABLE "inventory_transactions" DROP COLUMN "base_qty_after";--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "warehouse_locations" DROP COLUMN "min_qty";--> statement-breakpoint
ALTER TABLE "warehouse_locations" DROP COLUMN "max_qty";--> statement-breakpoint
ALTER TABLE "warehouse_locations" DROP COLUMN "max_weight";--> statement-breakpoint
ALTER TABLE "warehouse_locations" DROP COLUMN "width_inches";--> statement-breakpoint
ALTER TABLE "warehouse_locations" DROP COLUMN "height_inches";--> statement-breakpoint
ALTER TABLE "warehouse_locations" DROP COLUMN "depth_inches";