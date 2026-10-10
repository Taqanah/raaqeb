CREATE TABLE `incident_statuses` (
	`update_id` text NOT NULL,
	`component_id` text NOT NULL,
	`status` text NOT NULL,
	CONSTRAINT `incident_statuses_pk` PRIMARY KEY(`update_id`, `component_id`),
	CONSTRAINT `fk_incident_statuses_update_id_incident_updates_id_fk` FOREIGN KEY (`update_id`) REFERENCES `incident_updates`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_incident_statuses_component_id_components_id_fk` FOREIGN KEY (`component_id`) REFERENCES `components`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `incident_updates` (
	`id` text PRIMARY KEY,
	`incident_id` text NOT NULL,
	`stage` text NOT NULL,
	`message` text NOT NULL,
	`author` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_incident_updates_incident_id_incidents_id_fk` FOREIGN KEY (`incident_id`) REFERENCES `incidents`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `incidents` (
	`id` text PRIMARY KEY,
	`title` text NOT NULL,
	`impact` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE INDEX `incident_statuses_component_id` ON `incident_statuses` (`component_id`);--> statement-breakpoint
CREATE INDEX `incident_updates_incident_id` ON `incident_updates` (`incident_id`);