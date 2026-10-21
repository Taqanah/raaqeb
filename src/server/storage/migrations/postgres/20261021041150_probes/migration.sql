CREATE TABLE "monitor_probes" (
	"monitor_id" text,
	"probe_id" text,
	CONSTRAINT "monitor_probes_pkey" PRIMARY KEY("monitor_id","probe_id")
);
--> statement-breakpoint
CREATE TABLE "probes" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" bigint NOT NULL,
	"last_seen_at" bigint,
	"version" text,
	"round_trip_ms" integer
);
--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "from_main" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "confirmations" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "share_credentials" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "monitor_probes_probe_id" ON "monitor_probes" ("probe_id");--> statement-breakpoint
CREATE UNIQUE INDEX "probes_token_hash" ON "probes" ("token_hash");--> statement-breakpoint
ALTER TABLE "monitor_probes" ADD CONSTRAINT "monitor_probes_monitor_id_monitors_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "monitor_probes" ADD CONSTRAINT "monitor_probes_probe_id_probes_id_fkey" FOREIGN KEY ("probe_id") REFERENCES "probes"("id") ON DELETE CASCADE;