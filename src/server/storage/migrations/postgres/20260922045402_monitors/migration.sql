CREATE TABLE "groups" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL UNIQUE,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monitor_tags" (
	"monitor_id" text,
	"tag_id" text,
	CONSTRAINT "monitor_tags_pkey" PRIMARY KEY("monitor_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "monitors" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"description" text,
	"check_type" text NOT NULL,
	"target" text,
	"config" text NOT NULL,
	"interval_ms" integer NOT NULL,
	"timeout_ms" integer NOT NULL,
	"retries" integer NOT NULL,
	"degraded_ms" integer,
	"paused" integer NOT NULL,
	"group_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL UNIQUE
);
--> statement-breakpoint
CREATE INDEX "monitor_tags_tag_id" ON "monitor_tags" ("tag_id");--> statement-breakpoint
CREATE INDEX "monitors_group_id" ON "monitors" ("group_id");--> statement-breakpoint
ALTER TABLE "monitor_tags" ADD CONSTRAINT "monitor_tags_monitor_id_monitors_id_fkey" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "monitor_tags" ADD CONSTRAINT "monitor_tags_tag_id_tags_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_group_id_groups_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE SET NULL;