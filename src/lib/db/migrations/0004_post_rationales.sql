CREATE TABLE `post_rationales` (
	`post_id` integer PRIMARY KEY NOT NULL,
	`topic_anchor` text NOT NULL,
	`rationale_text` text NOT NULL,
	`evidence_sufficient` integer NOT NULL,
	`model_id` text NOT NULL,
	`prompt_version` text NOT NULL,
	`created_at` text NOT NULL
);
