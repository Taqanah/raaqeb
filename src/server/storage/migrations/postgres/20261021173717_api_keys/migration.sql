CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY,
	"account_id" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL UNIQUE,
	"created_at" bigint NOT NULL,
	"expires_at" bigint,
	"last_used_at" bigint,
	"last_used_address" text
);
--> statement-breakpoint
CREATE INDEX "api_keys_account_id" ON "api_keys" ("account_id");--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_account_id_auth_user_id_fkey" FOREIGN KEY ("account_id") REFERENCES "auth_user"("id") ON DELETE CASCADE;