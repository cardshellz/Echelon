export const SHARED_SHIPPING_LEGACY_FIXTURE_SQL = `CREATE SCHEMA shipping; CREATE SCHEMA dropship; CREATE SCHEMA warehouse; CREATE SCHEMA catalog; CREATE SCHEMA channels;
      CREATE TABLE channels.channels(id integer PRIMARY KEY,name text,type text,provider text,status text,shipping_config jsonb);
      CREATE TABLE channels.channel_warehouse_assignments(channel_id integer,warehouse_id integer,enabled boolean);
      CREATE TABLE catalog.product_variants(id integer PRIMARY KEY,sku text,product_id integer,weight_grams numeric,length_mm numeric,width_mm numeric,height_mm numeric,ships_in_own_container boolean,max_units_per_package integer);
      CREATE TABLE catalog.products(id integer PRIMARY KEY,shipping_group_id integer);
      CREATE TABLE catalog.shipping_groups(id integer PRIMARY KEY,code text);
      INSERT INTO catalog.shipping_groups VALUES(1,'protection');
      INSERT INTO catalog.products VALUES(1,1);
      CREATE TABLE dropship.dropship_package_profiles(product_variant_id integer,default_box_id integer,default_carrier text,default_service text,is_active boolean);
      CREATE TABLE warehouse.warehouses(id integer PRIMARY KEY,name text);
      INSERT INTO warehouse.warehouses VALUES (1,'Main'),(2,'West');
      CREATE TABLE shipping.box_catalog(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,code text UNIQUE,name text,kind text,
        length_mm integer,width_mm integer,height_mm integer,tare_weight_grams integer,max_weight_grams integer,
        cost_cents integer,fill_factor_bps integer,is_active boolean,created_at timestamptz,updated_at timestamptz);
      INSERT INTO shipping.box_catalog(code,name,kind,length_mm,width_mm,height_mm,tare_weight_grams,cost_cents,fill_factor_bps,is_active)
        VALUES ('SHARED','Shared box','box',200,150,100,45,0,8500,true);
      CREATE TABLE shipping.box_warehouse_stock(box_id integer,warehouse_id integer,is_stocked boolean);
      CREATE TABLE shipping.pack_plans(id integer PRIMARY KEY);
      CREATE TABLE shipping.pack_plan_parcels(id integer PRIMARY KEY);
      CREATE TABLE dropship.dropship_box_catalog(id integer PRIMARY KEY,code text,name text,length_mm integer,width_mm integer,height_mm integer,tare_weight_grams integer,max_weight_grams integer,is_active boolean);
      INSERT INTO dropship.dropship_box_catalog VALUES(7,'LEGACY','Dropship box',203,152,102,45,NULL,true);
      INSERT INTO catalog.product_variants VALUES(66,'ARM-ENV-SGL-P50',1,590,152,127,51,false,NULL);
      INSERT INTO dropship.dropship_package_profiles VALUES(66,7,'USPS','Ground Advantage',true);
      CREATE TABLE shipping.rate_books(id integer PRIMARY KEY,name text,status text);
      INSERT INTO shipping.rate_books VALUES(1,'Dropship','active'),(2,'Retail','active');
      CREATE TABLE shipping.rate_book_assignments(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,rate_book_id integer,is_active boolean,pricing_channel text,rate_purpose text,origin_warehouse_id integer,updated_at timestamptz);
      INSERT INTO shipping.rate_book_assignments(rate_book_id,is_active,pricing_channel,rate_purpose) VALUES(1,true,'dropship','vendor_fulfillment_charge'),(2,true,'shopify','customer_checkout');
      CREATE TABLE shipping.channel_policies(id integer PRIMARY KEY,status text,purpose text,channel_id integer);
      CREATE TABLE shipping.channel_policy_routes(id integer,policy_id integer,rate_book_id integer,origin_warehouse_id integer);
      CREATE TABLE shipping.service_levels(id integer PRIMARY KEY,code text,is_active boolean,display_name text,sort_order integer);
      INSERT INTO shipping.service_levels VALUES(1,'standard',true,'Standard',1),(2,'expedited',true,'Expedited',2);
      CREATE TABLE dropship.dropship_shipping_markup_config(id integer,markup_bps integer,fixed_markup_cents bigint,min_markup_cents bigint,max_markup_cents bigint,is_active boolean,effective_from timestamptz,effective_to timestamptz);
      INSERT INTO dropship.dropship_shipping_markup_config VALUES(1,100,0,NULL,NULL,true,'2026-01-01',NULL);
      CREATE TABLE dropship.dropship_insurance_pool_config(id integer,fee_bps integer,min_fee_cents bigint,max_fee_cents bigint,is_active boolean,effective_from timestamptz,effective_to timestamptz);
      INSERT INTO dropship.dropship_insurance_pool_config VALUES(1,200,NULL,NULL,true,'2026-01-01',NULL);`;
