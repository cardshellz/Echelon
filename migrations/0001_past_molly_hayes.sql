CREATE TABLE "adjustment_reasons" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "adjustment_reasons_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"code" varchar(30) NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"transaction_type" varchar(30) NOT NULL,
	"requires_note" integer DEFAULT 0 NOT NULL,
	"is_active" integer DEFAULT 1 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "adjustment_reasons_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "app_settings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"key" varchar(100) NOT NULL,
	"value" text,
	"type" varchar(20) DEFAULT 'string' NOT NULL,
	"category" varchar(50) DEFAULT 'general' NOT NULL,
	"description" text,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "app_settings_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "auth_permissions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "auth_permissions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"resource" varchar(50) NOT NULL,
	"action" varchar(50) NOT NULL,
	"description" text,
	"category" varchar(50) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_role_permissions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "auth_role_permissions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"role_id" integer NOT NULL,
	"permission_id" integer NOT NULL,
	"constraints" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_roles" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "auth_roles_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" varchar(100) NOT NULL,
	"description" text,
	"is_system" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "auth_roles_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "auth_user_roles" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "auth_user_roles_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" varchar NOT NULL,
	"role_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_assets" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "catalog_assets_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"catalog_product_id" integer NOT NULL,
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
CREATE TABLE "catalog_products" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "catalog_products_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"inventory_item_id" integer NOT NULL,
	"title" varchar(500) NOT NULL,
	"description" text,
	"bullet_points" jsonb,
	"category" varchar(200),
	"subcategory" varchar(200),
	"brand" varchar(100),
	"manufacturer" varchar(200),
	"tags" jsonb,
	"seo_title" varchar(200),
	"seo_description" text,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_products_inventory_item_id_unique" UNIQUE("inventory_item_id")
);
--> statement-breakpoint
CREATE TABLE "channel_asset_overrides" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "channel_asset_overrides_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"channel_id" integer NOT NULL,
	"catalog_asset_id" integer NOT NULL,
	"url_override" text,
	"alt_text_override" varchar(500),
	"position_override" integer,
	"is_included" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_connections" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "channel_connections_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"channel_id" integer NOT NULL,
	"shop_domain" varchar(255),
	"access_token" text,
	"refresh_token" text,
	"webhook_secret" varchar(255),
	"api_version" varchar(20),
	"scopes" text,
	"expires_at" timestamp,
	"last_sync_at" timestamp,
	"sync_status" varchar(20) DEFAULT 'never',
	"sync_error" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_feeds" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "channel_feeds_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"variant_id" integer NOT NULL,
	"channel_type" varchar(30) DEFAULT 'shopify' NOT NULL,
	"channel_variant_id" varchar(100) NOT NULL,
	"channel_product_id" varchar(100),
	"channel_sku" varchar(100),
	"is_active" integer DEFAULT 1 NOT NULL,
	"last_synced_at" timestamp,
	"last_synced_qty" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_listings" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "channel_listings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"channel_id" integer NOT NULL,
	"variant_id" integer NOT NULL,
	"external_product_id" varchar(100),
	"external_variant_id" varchar(100),
	"external_sku" varchar(100),
	"external_url" text,
	"last_synced_qty" integer,
	"last_synced_price" integer,
	"last_synced_at" timestamp,
	"sync_status" varchar(20) DEFAULT 'pending',
	"sync_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_pricing" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "channel_pricing_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"channel_id" integer NOT NULL,
	"variant_id" integer NOT NULL,
	"price" integer NOT NULL,
	"compare_at_price" integer,
	"cost" integer,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_product_overrides" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "channel_product_overrides_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"channel_id" integer NOT NULL,
	"catalog_product_id" integer NOT NULL,
	"title_override" varchar(500),
	"description_override" text,
	"bullet_points_override" jsonb,
	"category_override" varchar(200),
	"tags_override" jsonb,
	"is_listed" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_reservations" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "channel_reservations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"channel_id" integer NOT NULL,
	"inventory_item_id" integer NOT NULL,
	"reserve_base_qty" integer DEFAULT 0 NOT NULL,
	"min_stock_base" integer DEFAULT 0,
	"max_stock_base" integer,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_variant_overrides" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "channel_variant_overrides_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"channel_id" integer NOT NULL,
	"variant_id" integer NOT NULL,
	"name_override" varchar(500),
	"sku_override" varchar(100),
	"barcode_override" varchar(100),
	"weight_override" integer,
	"is_listed" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "channels_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" varchar(100) NOT NULL,
	"type" varchar(20) DEFAULT 'internal' NOT NULL,
	"provider" varchar(30) NOT NULL,
	"status" varchar(20) DEFAULT 'pending_setup' NOT NULL,
	"is_default" integer DEFAULT 0 NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_items" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inventory_items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"base_sku" varchar(100) NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"base_unit" varchar(20) DEFAULT 'each' NOT NULL,
	"cost_per_unit" integer,
	"image_url" text,
	"active" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_items_base_sku_unique" UNIQUE("base_sku")
);
--> statement-breakpoint
CREATE TABLE "inventory_levels" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inventory_levels_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"inventory_item_id" integer NOT NULL,
	"warehouse_location_id" integer NOT NULL,
	"variant_id" integer,
	"variant_qty" integer DEFAULT 0 NOT NULL,
	"on_hand_base" integer DEFAULT 0 NOT NULL,
	"reserved_base" integer DEFAULT 0 NOT NULL,
	"picked_base" integer DEFAULT 0 NOT NULL,
	"packed_base" integer DEFAULT 0 NOT NULL,
	"backorder_base" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_transactions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inventory_transactions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"inventory_item_id" integer NOT NULL,
	"variant_id" integer,
	"warehouse_location_id" integer,
	"transaction_type" varchar(30) NOT NULL,
	"reason_id" integer,
	"base_qty_delta" integer NOT NULL,
	"variant_qty_delta" integer,
	"base_qty_before" integer,
	"base_qty_after" integer,
	"variant_qty_before" integer,
	"variant_qty_after" integer,
	"batch_id" varchar(50),
	"source_state" varchar(20),
	"target_state" varchar(20),
	"order_id" integer,
	"order_item_id" integer,
	"reference_type" varchar(30),
	"reference_id" varchar(100),
	"notes" text,
	"is_implicit" integer DEFAULT 0 NOT NULL,
	"user_id" varchar(100),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "order_items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"order_id" integer NOT NULL,
	"shopify_line_item_id" varchar(50),
	"source_item_id" varchar(100),
	"sku" varchar(100) NOT NULL,
	"name" text NOT NULL,
	"image_url" text,
	"barcode" varchar(100),
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
CREATE TABLE "orders" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "orders_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"channel_id" integer,
	"source" varchar(20) DEFAULT 'shopify' NOT NULL,
	"external_order_id" varchar(100),
	"source_table_id" varchar(100),
	"shopify_order_id" varchar(50),
	"order_number" varchar(50) NOT NULL,
	"customer_name" text NOT NULL,
	"customer_email" text,
	"shipping_address" text,
	"shipping_city" text,
	"shipping_state" text,
	"shipping_postal_code" text,
	"shipping_country" text,
	"priority" varchar(20) DEFAULT 'normal' NOT NULL,
	"status" varchar(20) DEFAULT 'ready' NOT NULL,
	"on_hold" integer DEFAULT 0 NOT NULL,
	"held_at" timestamp,
	"assigned_picker_id" varchar(100),
	"batch_id" varchar(50),
	"item_count" integer DEFAULT 0 NOT NULL,
	"unit_count" integer DEFAULT 0 NOT NULL,
	"picked_count" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"short_reason" text,
	"total_amount" text,
	"currency" varchar(3) DEFAULT 'USD',
	"order_placed_at" timestamp,
	"shopify_created_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"exception_at" timestamp,
	"exception_resolution" varchar(20),
	"exception_resolved_at" timestamp,
	"exception_resolved_by" varchar(100),
	"exception_notes" text,
	CONSTRAINT "orders_shopify_order_id_unique" UNIQUE("shopify_order_id")
);
--> statement-breakpoint
CREATE TABLE "partner_profiles" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "partner_profiles_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"channel_id" integer NOT NULL,
	"company_name" varchar(200) NOT NULL,
	"contact_name" varchar(100),
	"contact_email" varchar(255),
	"contact_phone" varchar(50),
	"billing_email" varchar(255),
	"discount_percent" integer DEFAULT 0,
	"markup_percent" integer DEFAULT 0,
	"sla_days" integer DEFAULT 3,
	"allow_backorder" integer DEFAULT 0 NOT NULL,
	"auto_fulfill" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "partner_profiles_channel_id_unique" UNIQUE("channel_id")
);
--> statement-breakpoint
CREATE TABLE "picking_logs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "picking_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"action_type" varchar(30) NOT NULL,
	"picker_id" varchar(100),
	"picker_name" varchar(100),
	"picker_role" varchar(20),
	"order_id" integer,
	"order_number" varchar(50),
	"order_item_id" integer,
	"sku" varchar(100),
	"item_name" text,
	"location_code" varchar(50),
	"qty_requested" integer,
	"qty_before" integer,
	"qty_after" integer,
	"qty_delta" integer,
	"reason" text,
	"notes" text,
	"device_type" varchar(20),
	"session_id" varchar(100),
	"pick_method" varchar(20),
	"order_status_before" varchar(20),
	"order_status_after" varchar(20),
	"item_status_before" varchar(20),
	"item_status_after" varchar(20),
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "uom_variants" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "uom_variants_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"sku" varchar(100) NOT NULL,
	"inventory_item_id" integer NOT NULL,
	"name" text NOT NULL,
	"units_per_variant" integer NOT NULL,
	"hierarchy_level" integer DEFAULT 1 NOT NULL,
	"parent_variant_id" integer,
	"barcode" varchar(100),
	"image_url" text,
	"active" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uom_variants_sku_unique" UNIQUE("sku")
);
--> statement-breakpoint
CREATE TABLE "warehouse_locations" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "warehouse_locations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"warehouse_id" integer,
	"code" varchar(50) NOT NULL,
	"name" text,
	"zone" varchar(10),
	"aisle" varchar(5),
	"bay" varchar(5),
	"level" varchar(5),
	"bin" varchar(5),
	"location_type" varchar(30) DEFAULT 'forward_pick' NOT NULL,
	"is_pickable" integer DEFAULT 1 NOT NULL,
	"pick_sequence" integer,
	"parent_location_id" integer,
	"movement_policy" varchar(20) DEFAULT 'implicit' NOT NULL,
	"min_qty" integer,
	"max_qty" integer,
	"max_weight" integer,
	"width_inches" integer,
	"height_inches" integer,
	"depth_inches" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "warehouse_locations_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "warehouse_zones" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "warehouse_zones_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"code" varchar(10) NOT NULL,
	"name" varchar(50) NOT NULL,
	"description" text,
	"location_type" varchar(30) DEFAULT 'forward_pick' NOT NULL,
	"is_pickable" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "warehouse_zones_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "warehouses" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "warehouses_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"code" varchar(20) NOT NULL,
	"name" varchar(200) NOT NULL,
	"address" text,
	"city" varchar(100),
	"state" varchar(50),
	"postal_code" varchar(20),
	"country" varchar(50) DEFAULT 'US',
	"timezone" varchar(50) DEFAULT 'America/New_York',
	"is_active" integer DEFAULT 1 NOT NULL,
	"is_default" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "warehouses_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "product_locations" ADD COLUMN "warehouse_location_id" integer;--> statement-breakpoint
ALTER TABLE "product_locations" ADD COLUMN "status" varchar(20) DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_locations" ADD COLUMN "image_url" text;--> statement-breakpoint
ALTER TABLE "product_locations" ADD COLUMN "barcode" varchar(100);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role" varchar(20) DEFAULT 'picker' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "active" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "created_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_login_at" timestamp;--> statement-breakpoint
ALTER TABLE "auth_role_permissions" ADD CONSTRAINT "auth_role_permissions_role_id_auth_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."auth_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_role_permissions" ADD CONSTRAINT "auth_role_permissions_permission_id_auth_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."auth_permissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_user_roles" ADD CONSTRAINT "auth_user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_user_roles" ADD CONSTRAINT "auth_user_roles_role_id_auth_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."auth_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_assets" ADD CONSTRAINT "catalog_assets_catalog_product_id_catalog_products_id_fk" FOREIGN KEY ("catalog_product_id") REFERENCES "public"."catalog_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_products" ADD CONSTRAINT "catalog_products_inventory_item_id_inventory_items_id_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_asset_overrides" ADD CONSTRAINT "channel_asset_overrides_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_asset_overrides" ADD CONSTRAINT "channel_asset_overrides_catalog_asset_id_catalog_assets_id_fk" FOREIGN KEY ("catalog_asset_id") REFERENCES "public"."catalog_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_feeds" ADD CONSTRAINT "channel_feeds_variant_id_uom_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."uom_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_listings" ADD CONSTRAINT "channel_listings_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_listings" ADD CONSTRAINT "channel_listings_variant_id_uom_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."uom_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_pricing" ADD CONSTRAINT "channel_pricing_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_pricing" ADD CONSTRAINT "channel_pricing_variant_id_uom_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."uom_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_product_overrides" ADD CONSTRAINT "channel_product_overrides_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_product_overrides" ADD CONSTRAINT "channel_product_overrides_catalog_product_id_catalog_products_id_fk" FOREIGN KEY ("catalog_product_id") REFERENCES "public"."catalog_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_reservations" ADD CONSTRAINT "channel_reservations_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_reservations" ADD CONSTRAINT "channel_reservations_inventory_item_id_inventory_items_id_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_variant_overrides" ADD CONSTRAINT "channel_variant_overrides_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_variant_overrides" ADD CONSTRAINT "channel_variant_overrides_variant_id_uom_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."uom_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_levels" ADD CONSTRAINT "inventory_levels_inventory_item_id_inventory_items_id_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_levels" ADD CONSTRAINT "inventory_levels_warehouse_location_id_warehouse_locations_id_fk" FOREIGN KEY ("warehouse_location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_levels" ADD CONSTRAINT "inventory_levels_variant_id_uom_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."uom_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_inventory_item_id_inventory_items_id_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_variant_id_uom_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."uom_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_warehouse_location_id_warehouse_locations_id_fk" FOREIGN KEY ("warehouse_location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_reason_id_adjustment_reasons_id_fk" FOREIGN KEY ("reason_id") REFERENCES "public"."adjustment_reasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_transactions" ADD CONSTRAINT "inventory_transactions_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_profiles" ADD CONSTRAINT "partner_profiles_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "picking_logs" ADD CONSTRAINT "picking_logs_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "picking_logs" ADD CONSTRAINT "picking_logs_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uom_variants" ADD CONSTRAINT "uom_variants_inventory_item_id_inventory_items_id_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_locations" ADD CONSTRAINT "warehouse_locations_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_permissions_resource_action_idx" ON "auth_permissions" USING btree ("resource","action");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_role_permissions_role_perm_idx" ON "auth_role_permissions" USING btree ("role_id","permission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_user_roles_user_role_idx" ON "auth_user_roles" USING btree ("user_id","role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_asset_overrides_channel_asset_idx" ON "channel_asset_overrides" USING btree ("channel_id","catalog_asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_listings_channel_variant_idx" ON "channel_listings" USING btree ("channel_id","variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_pricing_channel_variant_idx" ON "channel_pricing" USING btree ("channel_id","variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_product_overrides_channel_product_idx" ON "channel_product_overrides" USING btree ("channel_id","catalog_product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_reservations_channel_item_idx" ON "channel_reservations" USING btree ("channel_id","inventory_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_variant_overrides_channel_variant_idx" ON "channel_variant_overrides" USING btree ("channel_id","variant_id");--> statement-breakpoint
ALTER TABLE "product_locations" ADD CONSTRAINT "product_locations_warehouse_location_id_warehouse_locations_id_fk" FOREIGN KEY ("warehouse_location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE set null ON UPDATE no action;