ALTER TABLE "status_pages" ADD COLUMN "access" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "status_pages" ADD COLUMN "access_password" text;--> statement-breakpoint
ALTER TABLE "status_pages" ADD COLUMN "access_addresses" text DEFAULT '[]' NOT NULL;