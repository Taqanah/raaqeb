CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY,
	`account_id` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`token_hash` text NOT NULL UNIQUE,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`last_used_at` integer,
	`last_used_address` text,
	CONSTRAINT `fk_api_keys_account_id_auth_user_id_fk` FOREIGN KEY (`account_id`) REFERENCES `auth_user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `api_keys_account_id` ON `api_keys` (`account_id`);