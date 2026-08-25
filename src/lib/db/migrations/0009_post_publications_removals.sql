CREATE TABLE `post_publications` (
	`post_id` integer PRIMARY KEY NOT NULL REFERENCES `posts`(`id`),
	`published_at` text NOT NULL,
	`body_hash` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_post_publications_published_at` ON `post_publications` (`published_at`);--> statement-breakpoint
CREATE TABLE `post_removals` (
	`post_id` integer PRIMARY KEY NOT NULL REFERENCES `posts`(`id`),
	`kind` text NOT NULL,
	`reason` text NOT NULL,
	`removed_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_post_removals_removed_at` ON `post_removals` (`removed_at`);--> statement-breakpoint
CREATE TABLE `post_retry_queue` (
	`url_hash` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`host` text NOT NULL,
	`lane` text NOT NULL,
	`reason` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`first_queued_at` text NOT NULL,
	`next_attempt_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_post_retry_queue_due` ON `post_retry_queue` (`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `discovery_host_metrics` (
	`host` text NOT NULL,
	`day` text NOT NULL,
	`processed` integer DEFAULT 0 NOT NULL,
	`published` integer DEFAULT 0 NOT NULL,
	`dropped` integer DEFAULT 0 NOT NULL,
	`promotional` integer DEFAULT 0 NOT NULL,
	`author_present` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`host`, `day`)
);
