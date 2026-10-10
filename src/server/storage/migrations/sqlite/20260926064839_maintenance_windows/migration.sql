CREATE TABLE `maintenance_components` (
	`window_id` text NOT NULL,
	`component_id` text NOT NULL,
	CONSTRAINT `maintenance_components_pk` PRIMARY KEY(`window_id`, `component_id`),
	CONSTRAINT `fk_maintenance_components_window_id_maintenance_windows_id_fk` FOREIGN KEY (`window_id`) REFERENCES `maintenance_windows`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_maintenance_components_component_id_components_id_fk` FOREIGN KEY (`component_id`) REFERENCES `components`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `maintenance_windows` (
	`id` text PRIMARY KEY,
	`title` text NOT NULL,
	`message` text NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`stage` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `maintenance_components_component_id` ON `maintenance_components` (`component_id`);