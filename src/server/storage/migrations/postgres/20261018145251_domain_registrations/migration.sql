CREATE TABLE "domain_registrations" (
	"monitor_id" text PRIMARY KEY,
	"domain" text,
	"expires_at" bigint,
	"read_at" bigint NOT NULL,
	"warned" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "domain_registrations" ADD CONSTRAINT "domain_registrations_monitor_id_monitors_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id") ON DELETE CASCADE;
--> statement-breakpoint
UPDATE monitors SET events = substr(events, 1, length(events) - 1) || ',"domain_expiring"]' WHERE events <> '[]';