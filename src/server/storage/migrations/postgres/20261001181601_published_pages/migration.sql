ALTER TABLE "status_pages" ADD COLUMN "published" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Hand-written data step: every page that exists now stays public; a new page starts unpublished.
UPDATE "status_pages" SET "published" = 1;
