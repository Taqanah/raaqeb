CREATE TABLE `monitor_probes` (
	`monitor_id` text NOT NULL,
	`probe_id` text NOT NULL,
	CONSTRAINT `monitor_probes_pk` PRIMARY KEY(`monitor_id`, `probe_id`),
	CONSTRAINT `fk_monitor_probes_monitor_id_monitors_id_fk` FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_monitor_probes_probe_id_probes_id_fk` FOREIGN KEY (`probe_id`) REFERENCES `probes`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `probes` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer,
	`version` text,
	`round_trip_ms` integer
);
--> statement-breakpoint
ALTER TABLE `monitors` ADD `from_main` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `monitors` ADD `confirmations` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `monitors` ADD `share_credentials` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `monitor_probes_probe_id` ON `monitor_probes` (`probe_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `probes_token_hash` ON `probes` (`token_hash`);