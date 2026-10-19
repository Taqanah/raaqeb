CREATE TABLE "maintenance_series" (
	"id" text PRIMARY KEY,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"recurrence" text NOT NULL,
	"skipped_starts" text DEFAULT '[]' NOT NULL,
	"scheduled_until" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_series_components" (
	"series_id" text,
	"component_id" text,
	CONSTRAINT "maintenance_series_components_pkey" PRIMARY KEY("series_id","component_id")
);
--> statement-breakpoint
ALTER TABLE "maintenance_windows" ADD COLUMN "series_id" text;--> statement-breakpoint
ALTER TABLE "maintenance_windows" ADD COLUMN "series_starts_at" bigint;--> statement-breakpoint
CREATE INDEX "maintenance_series_components_component_id" ON "maintenance_series_components" ("component_id");--> statement-breakpoint
CREATE INDEX "maintenance_windows_series_id" ON "maintenance_windows" ("series_id");--> statement-breakpoint
ALTER TABLE "maintenance_series_components" ADD CONSTRAINT "maintenance_series_components_yaL1tr06Nsr4_fkey" FOREIGN KEY ("series_id") REFERENCES "maintenance_series"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "maintenance_series_components" ADD CONSTRAINT "maintenance_series_components_component_id_components_id_fkey" FOREIGN KEY ("component_id") REFERENCES "components"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "maintenance_windows" ADD CONSTRAINT "maintenance_windows_series_id_maintenance_series_id_fkey" FOREIGN KEY ("series_id") REFERENCES "maintenance_series"("id") ON DELETE SET NULL;