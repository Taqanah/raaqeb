ALTER TABLE `heartbeats` ADD `failed` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `heartbeats` ADD `exit_code` integer;--> statement-breakpoint
ALTER TABLE `heartbeats` ADD `message` text;