CREATE TABLE `heartbeats` (
	`monitor_id` text NOT NULL,
	`arrived_at` integer NOT NULL,
	`source_ip` text,
	CONSTRAINT `heartbeats_pk` PRIMARY KEY(`monitor_id`, `arrived_at`),
	CONSTRAINT `fk_heartbeats_monitor_id_monitors_id_fk` FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `monitors` ADD `heartbeat_token` text;--> statement-breakpoint
CREATE UNIQUE INDEX `monitors_heartbeat_token` ON `monitors` (`heartbeat_token`);