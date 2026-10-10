CREATE TABLE "channels" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"config" text NOT NULL,
	"credentials" text,
	"locale" text,
	"applies_to_new" integer NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monitor_channels" (
	"monitor_id" text,
	"channel_id" text,
	CONSTRAINT "monitor_channels_pkey" PRIMARY KEY("monitor_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY,
	"channel_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" text NOT NULL,
	"status" text NOT NULL,
	"attempts" integer NOT NULL,
	"queued_at" bigint NOT NULL,
	"next_attempt_at" bigint,
	"finished_at" bigint,
	"reason" integer,
	"failure" text
);
--> statement-breakpoint
CREATE INDEX "monitor_channels_channel_id" ON "monitor_channels" ("channel_id");--> statement-breakpoint
CREATE INDEX "notifications_due" ON "notifications" ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "notifications_channel" ON "notifications" ("channel_id","queued_at");--> statement-breakpoint
ALTER TABLE "monitor_channels" ADD CONSTRAINT "monitor_channels_monitor_id_monitors_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "monitor_channels" ADD CONSTRAINT "monitor_channels_channel_id_channels_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_channel_id_channels_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE;