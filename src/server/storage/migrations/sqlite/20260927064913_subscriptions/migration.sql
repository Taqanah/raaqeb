CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY,
	`page_id` text NOT NULL,
	`channel` text NOT NULL,
	`address` text NOT NULL,
	`credentials` text,
	`locale` text NOT NULL,
	`token` text NOT NULL,
	`status` text NOT NULL,
	`requested_at` integer NOT NULL,
	`confirmed_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_subscriptions_page_id_status_pages_id_fk` FOREIGN KEY (`page_id`) REFERENCES `status_pages`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_notifications` (
	`id` text PRIMARY KEY,
	`channel_id` text,
	`subscription_id` text,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer NOT NULL,
	`queued_at` integer NOT NULL,
	`next_attempt_at` integer,
	`finished_at` integer,
	`reason` integer,
	`failure` text,
	CONSTRAINT `fk_notifications_channel_id_channels_id_fk` FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_notifications_subscription_id_subscriptions_id_fk` FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions`(`id`) ON DELETE CASCADE,
	CONSTRAINT "notifications_target" CHECK(("channel_id" IS NULL) <> ("subscription_id" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_notifications`(`id`, `channel_id`, `kind`, `payload`, `status`, `attempts`, `queued_at`, `next_attempt_at`, `finished_at`, `reason`, `failure`) SELECT `id`, `channel_id`, `kind`, `payload`, `status`, `attempts`, `queued_at`, `next_attempt_at`, `finished_at`, `reason`, `failure` FROM `notifications`;--> statement-breakpoint
DROP TABLE `notifications`;--> statement-breakpoint
ALTER TABLE `__new_notifications` RENAME TO `notifications`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `notifications_due` ON `notifications` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `notifications_channel` ON `notifications` (`channel_id`,`queued_at`);--> statement-breakpoint
CREATE INDEX `notifications_subscription` ON `notifications` (`subscription_id`,`queued_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_token` ON `subscriptions` (`token`);--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_address` ON `subscriptions` (`page_id`,`channel`,`address`);