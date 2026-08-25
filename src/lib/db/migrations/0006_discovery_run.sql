CREATE TABLE `discovery_run` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`host` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`sitemaps_fetched` integer NOT NULL,
	`urls_new` integer NOT NULL,
	`urls_fetched` integer NOT NULL,
	`status_counts` text NOT NULL,
	`outcome` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_discovery_run_host` ON `discovery_run` (`host`, `started_at`);
