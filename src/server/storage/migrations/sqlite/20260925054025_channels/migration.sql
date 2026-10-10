CREATE TABLE `channels` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`config` text NOT NULL,
	`credentials` text,
	`locale` text,
	`applies_to_new` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `monitor_channels` (
	`monitor_id` text NOT NULL,
	`channel_id` text NOT NULL,
	CONSTRAINT `monitor_channels_pk` PRIMARY KEY(`monitor_id`, `channel_id`),
	CONSTRAINT `fk_monitor_channels_monitor_id_monitors_id_fk` FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_monitor_channels_channel_id_channels_id_fk` FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY,
	`channel_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer NOT NULL,
	`queued_at` integer NOT NULL,
	`next_attempt_at` integer,
	`finished_at` integer,
	`reason` integer,
	`failure` text,
	CONSTRAINT `fk_notifications_channel_id_channels_id_fk` FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `monitor_channels_channel_id` ON `monitor_channels` (`channel_id`);--> statement-breakpoint
CREATE INDEX `notifications_due` ON `notifications` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `notifications_channel` ON `notifications` (`channel_id`,`queued_at`);