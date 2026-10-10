CREATE TABLE "daily_rollups" (
	"monitor_id" text,
	"day" bigint,
	"checks" integer NOT NULL,
	"observed_ms" integer NOT NULL,
	"average_ms" integer,
	"min_ms" integer,
	"max_ms" integer,
	"failed" integer NOT NULL,
	"degraded" integer NOT NULL,
	CONSTRAINT "daily_rollups_pkey" PRIMARY KEY("monitor_id","day")
);
--> statement-breakpoint
CREATE TABLE "hourly_rollups" (
	"monitor_id" text,
	"hour" bigint,
	"checks" integer NOT NULL,
	"observed_ms" integer NOT NULL,
	"average_ms" integer,
	"min_ms" integer,
	"max_ms" integer,
	"failed" integer NOT NULL,
	"degraded" integer NOT NULL,
	CONSTRAINT "hourly_rollups_pkey" PRIMARY KEY("monitor_id","hour")
);
--> statement-breakpoint
CREATE TABLE "sealed_days" (
	"monitor_id" text,
	"day" bigint,
	"checks" integer NOT NULL,
	"observed_ms" integer NOT NULL,
	"chunk" bytea NOT NULL,
	CONSTRAINT "sealed_days_pkey" PRIMARY KEY("monitor_id","day")
);
--> statement-breakpoint
ALTER TABLE "daily_rollups" ADD CONSTRAINT "daily_rollups_monitor_id_monitors_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "hourly_rollups" ADD CONSTRAINT "hourly_rollups_monitor_id_monitors_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sealed_days" ADD CONSTRAINT "sealed_days_monitor_id_monitors_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id") ON DELETE CASCADE;