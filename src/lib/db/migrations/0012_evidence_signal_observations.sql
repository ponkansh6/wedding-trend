CREATE TABLE `evidence_signal_observations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`url_hash` text NOT NULL,
	`host` text NOT NULL,
	`text_length` integer NOT NULL,
	`link_density` real NOT NULL,
	`paragraph_count` integer NOT NULL,
	`passed_gate` integer NOT NULL,
	`failed_conditions` text,
	`observed_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_evidence_signal_observations_url_hash` ON `evidence_signal_observations` (`url_hash`);
