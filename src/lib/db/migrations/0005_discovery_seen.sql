CREATE TABLE `discovery_seen` (
	`host` text NOT NULL,
	`url_hash` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`sitemap_lastmod` text,
	`status` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_discovery_seen_host_status` ON `discovery_seen` (`host`, `status`);
