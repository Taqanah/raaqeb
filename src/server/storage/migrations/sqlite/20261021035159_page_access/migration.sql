ALTER TABLE `status_pages` ADD `access` text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE `status_pages` ADD `access_password` text;--> statement-breakpoint
ALTER TABLE `status_pages` ADD `access_addresses` text DEFAULT '[]' NOT NULL;