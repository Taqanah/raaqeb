CREATE TABLE "certificate_records" (
	"monitor_id" text PRIMARY KEY,
	"subject" text NOT NULL,
	"issuer" text NOT NULL,
	"valid_from" bigint NOT NULL,
	"valid_to" bigint NOT NULL,
	"names" text NOT NULL,
	"fingerprint" text NOT NULL,
	"last_seen_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "certificate_records" ADD CONSTRAINT "certificate_records_monitor_id_monitors_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id") ON DELETE CASCADE;