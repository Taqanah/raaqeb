CREATE TABLE "change_counter" (
	"id" integer PRIMARY KEY,
	"value" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY,
	"value" text NOT NULL,
	"updated_at" bigint NOT NULL
);

--> statement-breakpoint
INSERT INTO change_counter (id, value) VALUES (1, 0);
