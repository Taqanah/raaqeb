ALTER TABLE `certificate_records` ADD `warned` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `monitors` ADD `events` text DEFAULT '["down","recovered","degraded_started","degraded_ended","certificate_expiring"]' NOT NULL;--> statement-breakpoint
ALTER TABLE `monitors` ADD `reminder_ms` integer;