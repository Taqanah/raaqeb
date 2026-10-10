CREATE TABLE "maintenance_components" (
	"window_id" text,
	"component_id" text,
	CONSTRAINT "maintenance_components_pkey" PRIMARY KEY("window_id","component_id")
);
--> statement-breakpoint
CREATE TABLE "maintenance_windows" (
	"id" text PRIMARY KEY,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"starts_at" bigint NOT NULL,
	"ends_at" bigint NOT NULL,
	"stage" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "maintenance_components_component_id" ON "maintenance_components" ("component_id");--> statement-breakpoint
ALTER TABLE "maintenance_components" ADD CONSTRAINT "maintenance_components_window_id_maintenance_windows_id_fkey" FOREIGN KEY ("window_id") REFERENCES "maintenance_windows"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "maintenance_components" ADD CONSTRAINT "maintenance_components_component_id_components_id_fkey" FOREIGN KEY ("component_id") REFERENCES "components"("id") ON DELETE CASCADE;