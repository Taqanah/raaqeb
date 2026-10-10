CREATE TABLE "captures" (
	"monitor_id" text,
	"started_at" bigint,
	"headers" text NOT NULL,
	"body" bytea NOT NULL,
	CONSTRAINT "captures_pkey" PRIMARY KEY("monitor_id","started_at")
);
--> statement-breakpoint
CREATE TABLE "checks" (
	"monitor_id" text,
	"started_at" bigint,
	"result" integer NOT NULL,
	"response_ms" integer,
	"status_code" integer,
	"reason" integer NOT NULL,
	"attempts" integer NOT NULL,
	"bytes" integer NOT NULL,
	CONSTRAINT "checks_pkey" PRIMARY KEY("monitor_id","started_at")
);
--> statement-breakpoint
CREATE TABLE "failure_details" (
	"monitor_id" text,
	"started_at" bigint,
	"assertion" text,
	"params" text NOT NULL,
	"error" text,
	CONSTRAINT "failure_details_pkey" PRIMARY KEY("monitor_id","started_at")
);
--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_monitor_id_monitors_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "checks" ADD CONSTRAINT "checks_monitor_id_monitors_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "failure_details" ADD CONSTRAINT "failure_details_monitor_id_monitors_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id") ON DELETE CASCADE;