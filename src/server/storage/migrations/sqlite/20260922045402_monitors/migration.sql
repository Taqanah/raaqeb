CREATE TABLE `groups` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL UNIQUE,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `monitor_tags` (
	`monitor_id` text NOT NULL,
	`tag_id` text NOT NULL,
	CONSTRAINT `monitor_tags_pk` PRIMARY KEY(`monitor_id`, `tag_id`),
	CONSTRAINT `fk_monitor_tags_monitor_id_monitors_id_fk` FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_monitor_tags_tag_id_tags_id_fk` FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `monitors` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`description` text,
	`check_type` text NOT NULL,
	`target` text,
	`config` text NOT NULL,
	`interval_ms` integer NOT NULL,
	`timeout_ms` integer NOT NULL,
	`retries` integer NOT NULL,
	`degraded_ms` integer,
	`paused` integer NOT NULL,
	`group_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_monitors_group_id_groups_id_fk` FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL UNIQUE
);
--> statement-breakpoint
CREATE INDEX `monitor_tags_tag_id` ON `monitor_tags` (`tag_id`);--> statement-breakpoint
CREATE INDEX `monitors_group_id` ON `monitors` (`group_id`);