CREATE TABLE IF NOT EXISTS "startup_inventory_anomalies" (
	"id" serial PRIMARY KEY NOT NULL,
	"variant_id" integer NOT NULL,
	"location_id" integer NOT NULL,
	"qty_on_hand" integer NOT NULL,
	"detected_at" timestamp DEFAULT now() NOT NULL
);
