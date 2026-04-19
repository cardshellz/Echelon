DO $$ BEGIN
 ALTER TABLE "inventory"."inventory_transactions" ADD CONSTRAINT "inventory_transactions_inventory_lot_id_inventory_lots_id_fk" FOREIGN KEY ("inventory_lot_id") REFERENCES "inventory"."inventory_lots"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "inventory"."replen_tasks" ADD CONSTRAINT "replen_tasks_depends_on_task_id_replen_tasks_id_fk" FOREIGN KEY ("depends_on_task_id") REFERENCES "inventory"."replen_tasks"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "inventory"."cycle_count_items" ADD CONSTRAINT "cycle_count_items_related_item_id_cycle_count_items_id_fk" FOREIGN KEY ("related_item_id") REFERENCES "inventory"."cycle_count_items"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "inventory"."inventory_lots" ADD CONSTRAINT "inventory_lots_inbound_shipment_id_inbound_shipments_id_fk" FOREIGN KEY ("inbound_shipment_id") REFERENCES "procurement"."inbound_shipments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "inventory"."order_line_costs" ADD CONSTRAINT "order_line_costs_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "wms"."orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "inventory"."order_line_costs" ADD CONSTRAINT "order_line_costs_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "wms"."order_items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "inventory"."order_line_costs" ADD CONSTRAINT "order_line_costs_product_variant_id_product_variants_id_fk" FOREIGN KEY ("product_variant_id") REFERENCES "catalog"."product_variants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "inventory"."order_line_costs" ADD CONSTRAINT "order_line_costs_lot_id_inventory_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "inventory"."inventory_lots"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
