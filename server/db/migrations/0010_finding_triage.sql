CREATE TABLE `finding_triage` (
	`site_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`status` text NOT NULL,
	`reason` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`site_id`, `fingerprint`),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
