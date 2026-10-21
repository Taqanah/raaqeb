CREATE TABLE "audit_entries" (
	"id" text PRIMARY KEY,
	"at" bigint NOT NULL,
	"actor_id" text,
	"actor_email" text,
	"action" text NOT NULL,
	"target_id" text,
	"detail" text NOT NULL,
	"address" text
);
--> statement-breakpoint
CREATE INDEX "audit_entries_at" ON "audit_entries" ("at");