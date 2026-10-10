CREATE TABLE "incident_statuses" (
	"update_id" text,
	"component_id" text,
	"status" text NOT NULL,
	CONSTRAINT "incident_statuses_pkey" PRIMARY KEY("update_id","component_id")
);
--> statement-breakpoint
CREATE TABLE "incident_updates" (
	"id" text PRIMARY KEY,
	"incident_id" text NOT NULL,
	"stage" text NOT NULL,
	"message" text NOT NULL,
	"author" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" text PRIMARY KEY,
	"title" text NOT NULL,
	"impact" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"resolved_at" bigint
);
--> statement-breakpoint
CREATE INDEX "incident_statuses_component_id" ON "incident_statuses" ("component_id");--> statement-breakpoint
CREATE INDEX "incident_updates_incident_id" ON "incident_updates" ("incident_id");--> statement-breakpoint
ALTER TABLE "incident_statuses" ADD CONSTRAINT "incident_statuses_update_id_incident_updates_id_fkey" FOREIGN KEY ("update_id") REFERENCES "incident_updates"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "incident_statuses" ADD CONSTRAINT "incident_statuses_component_id_components_id_fkey" FOREIGN KEY ("component_id") REFERENCES "components"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "incident_updates" ADD CONSTRAINT "incident_updates_incident_id_incidents_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "incidents"("id") ON DELETE CASCADE;