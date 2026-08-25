CREATE TABLE `host_gate_state` (
	`host` text PRIMARY KEY NOT NULL,
	`gate_id` text,
	`state_kind` text,
	`until_at` text,
	`k4_strikes` integer DEFAULT 0 NOT NULL,
	`last_429_at` text,
	`count_day` text DEFAULT '' NOT NULL,
	`count_value` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
