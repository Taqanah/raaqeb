CREATE TABLE `certificate_records` (
	`monitor_id` text PRIMARY KEY,
	`subject` text NOT NULL,
	`issuer` text NOT NULL,
	`valid_from` integer NOT NULL,
	`valid_to` integer NOT NULL,
	`names` text NOT NULL,
	`fingerprint` text NOT NULL,
	`last_seen_at` integer NOT NULL,
	CONSTRAINT `fk_certificate_records_monitor_id_monitors_id_fk` FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON DELETE CASCADE
);
