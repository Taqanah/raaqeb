ALTER TABLE "certificate_records" ADD COLUMN "warned" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "events" text DEFAULT '["down","recovered","degraded_started","degraded_ended","certificate_expiring"]' NOT NULL;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "reminder_ms" integer;