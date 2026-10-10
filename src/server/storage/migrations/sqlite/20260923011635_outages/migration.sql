CREATE TABLE `outages` (
	`monitor_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`reason` integer NOT NULL,
	CONSTRAINT `outages_pk` PRIMARY KEY(`monitor_id`, `started_at`),
	CONSTRAINT `fk_outages_monitor_id_monitors_id_fk` FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON DELETE CASCADE
);
