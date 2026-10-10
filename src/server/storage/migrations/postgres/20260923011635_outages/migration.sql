CREATE TABLE "outages" (
	"monitor_id" text,
	"started_at" bigint,
	"ended_at" bigint,
	"reason" integer NOT NULL,
	CONSTRAINT "outages_pkey" PRIMARY KEY("monitor_id","started_at")
);
--> statement-breakpoint
ALTER TABLE "outages" ADD CONSTRAINT "outages_monitor_id_monitors_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id") ON DELETE CASCADE;