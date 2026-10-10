CREATE TABLE `component_groups` (
	`id` text PRIMARY KEY,
	`page_id` text NOT NULL,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	CONSTRAINT `fk_component_groups_page_id_status_pages_id_fk` FOREIGN KEY (`page_id`) REFERENCES `status_pages`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `component_monitors` (
	`component_id` text NOT NULL,
	`monitor_id` text NOT NULL,
	CONSTRAINT `component_monitors_pk` PRIMARY KEY(`component_id`, `monitor_id`),
	CONSTRAINT `fk_component_monitors_component_id_components_id_fk` FOREIGN KEY (`component_id`) REFERENCES `components`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_component_monitors_monitor_id_monitors_id_fk` FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `components` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`description` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `page_components` (
	`page_id` text NOT NULL,
	`component_id` text NOT NULL,
	`group_id` text,
	`position` integer NOT NULL,
	CONSTRAINT `page_components_pk` PRIMARY KEY(`page_id`, `component_id`),
	CONSTRAINT `fk_page_components_page_id_status_pages_id_fk` FOREIGN KEY (`page_id`) REFERENCES `status_pages`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_page_components_component_id_components_id_fk` FOREIGN KEY (`component_id`) REFERENCES `components`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_page_components_group_id_component_groups_id_fk` FOREIGN KEY (`group_id`) REFERENCES `component_groups`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `page_images` (
	`page_id` text NOT NULL,
	`kind` text NOT NULL,
	`content_type` text NOT NULL,
	`body` blob NOT NULL,
	`hash` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `page_images_pk` PRIMARY KEY(`page_id`, `kind`),
	CONSTRAINT `fk_page_images_page_id_status_pages_id_fk` FOREIGN KEY (`page_id`) REFERENCES `status_pages`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `status_pages` (
	`id` text PRIMARY KEY,
	`slug` text NOT NULL UNIQUE,
	`title` text NOT NULL,
	`locale` text NOT NULL,
	`custom_domain` text UNIQUE,
	`is_default` integer NOT NULL,
	`customization` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `monitors` ADD `paused_at` integer;--> statement-breakpoint
CREATE INDEX `component_groups_page_id` ON `component_groups` (`page_id`);--> statement-breakpoint
CREATE INDEX `component_monitors_monitor_id` ON `component_monitors` (`monitor_id`);--> statement-breakpoint
CREATE INDEX `page_components_component_id` ON `page_components` (`component_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `status_pages_default` ON `status_pages` (`is_default`) WHERE "is_default" = 1;

--> statement-breakpoint
-- A monitor already paused keeps the time of its last change as its pause.
UPDATE monitors SET paused_at = updated_at WHERE paused = 1;
