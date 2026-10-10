CREATE TABLE "heartbeats" (
	"monitor_id" text,
	"arrived_at" bigint,
	"source_ip" text,
	CONSTRAINT "heartbeats_pkey" PRIMARY KEY("monitor_id","arrived_at")
);
--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "heartbeat_token" text;--> statement-breakpoint
CREATE UNIQUE INDEX "monitors_heartbeat_token" ON "monitors" ("heartbeat_token");--> statement-breakpoint
ALTER TABLE "heartbeats" ADD CONSTRAINT "heartbeats_monitor_id_monitors_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id") ON DELETE CASCADE;