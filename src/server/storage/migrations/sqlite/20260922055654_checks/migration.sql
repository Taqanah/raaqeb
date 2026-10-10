CREATE TABLE `captures` (
	`monitor_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`headers` text NOT NULL,
	`body` blob NOT NULL,
	CONSTRAINT `captures_pk` PRIMARY KEY(`monitor_id`, `started_at`),
	CONSTRAINT `fk_captures_monitor_id_monitors_id_fk` FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `checks` (
	`monitor_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`result` integer NOT NULL,
	`response_ms` integer,
	`status_code` integer,
	`reason` integer NOT NULL,
	`attempts` integer NOT NULL,
	`bytes` integer NOT NULL,
	CONSTRAINT `checks_pk` PRIMARY KEY(`monitor_id`, `started_at`),
	CONSTRAINT `fk_checks_monitor_id_monitors_id_fk` FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON DELETE CASCADE
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `failure_details` (
	`monitor_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`assertion` text,
	`params` text NOT NULL,
	`error` text,
	CONSTRAINT `failure_details_pk` PRIMARY KEY(`monitor_id`, `started_at`),
	CONSTRAINT `fk_failure_details_monitor_id_monitors_id_fk` FOREIGN KEY (`monitor_id`) REFERENCES `monitors`(`id`) ON DELETE CASCADE
);
