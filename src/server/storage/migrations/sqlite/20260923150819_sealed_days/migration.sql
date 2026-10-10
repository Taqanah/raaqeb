CREATE TABLE `daily_rollups` (
	`monitor_id` text NOT NULL,
	`day` integer NOT NULL,
	`checks` integer NOT NULL,
	`observed_ms` integer NOT NULL,
	`average_ms` integer,
	`min_ms` integer,
	`max_ms` integer,
	`failed` integer NOT NULL,
	`degraded` integer NOT NULL,
	CONSTRAINT `daily_rollups_pk` PRIMARY KEY(`monitor_id`, `day`),
	CONSTRAINT `fk_daily_rollups_monitor_id_monitors_id_fk` FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `hourly_rollups` (
	`monitor_id` text NOT NULL,
	`hour` integer NOT NULL,
	`checks` integer NOT NULL,
	`observed_ms` integer NOT NULL,
	`average_ms` integer,
	`min_ms` integer,
	`max_ms` integer,
	`failed` integer NOT NULL,
	`degraded` integer NOT NULL,
	CONSTRAINT `hourly_rollups_pk` PRIMARY KEY(`monitor_id`, `hour`),
	CONSTRAINT `fk_hourly_rollups_monitor_id_monitors_id_fk` FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `sealed_days` (
	`monitor_id` text NOT NULL,
	`day` integer NOT NULL,
	`checks` integer NOT NULL,
	`observed_ms` integer NOT NULL,
	`chunk` blob NOT NULL,
	CONSTRAINT `sealed_days_pk` PRIMARY KEY(`monitor_id`, `day`),
	CONSTRAINT `fk_sealed_days_monitor_id_monitors_id_fk` FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON DELETE CASCADE
);
