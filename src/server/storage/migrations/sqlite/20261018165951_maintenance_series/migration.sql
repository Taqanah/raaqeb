CREATE TABLE `maintenance_series` (
	`id` text PRIMARY KEY,
	`title` text NOT NULL,
	`message` text NOT NULL,
	`recurrence` text NOT NULL,
	`skipped_starts` text DEFAULT '[]' NOT NULL,
	`scheduled_until` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `maintenance_series_components` (
	`series_id` text NOT NULL,
	`component_id` text NOT NULL,
	CONSTRAINT `maintenance_series_components_pk` PRIMARY KEY(`series_id`, `component_id`),
	CONSTRAINT `fk_maintenance_series_components_series_id_maintenance_series_id_fk` FOREIGN KEY (`series_id`) REFERENCES `maintenance_series`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_maintenance_series_components_component_id_components_id_fk` FOREIGN KEY (`component_id`) REFERENCES `components`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `maintenance_windows` ADD `series_id` text REFERENCES maintenance_series(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `maintenance_windows` ADD `series_starts_at` integer;--> statement-breakpoint
CREATE INDEX `maintenance_series_components_component_id` ON `maintenance_series_components` (`component_id`);--> statement-breakpoint
CREATE INDEX `maintenance_windows_series_id` ON `maintenance_windows` (`series_id`);