ALTER TABLE "heartbeats" ADD COLUMN "failed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeats" ADD COLUMN "exit_code" integer;--> statement-breakpoint
ALTER TABLE "heartbeats" ADD COLUMN "message" text;