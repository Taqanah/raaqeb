CREATE TABLE "subscriptions" (
	"id" text PRIMARY KEY,
	"page_id" text NOT NULL,
	"channel" text NOT NULL,
	"address" text NOT NULL,
	"credentials" text,
	"locale" text NOT NULL,
	"token" text NOT NULL,
	"status" text NOT NULL,
	"requested_at" bigint NOT NULL,
	"confirmed_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "subscription_id" text;--> statement-breakpoint
ALTER TABLE "notifications" ALTER COLUMN "channel_id" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "notifications_subscription" ON "notifications" ("subscription_id","queued_at");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_token" ON "subscriptions" ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_address" ON "subscriptions" ("page_id","channel","address");--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_subscription_id_subscriptions_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_page_id_status_pages_id_fkey" FOREIGN KEY ("page_id") REFERENCES "status_pages"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_target" CHECK (("channel_id" IS NULL) <> ("subscription_id" IS NULL));