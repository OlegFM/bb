ALTER TABLE `environments` ADD `path_key` text;--> statement-breakpoint
UPDATE `environments` SET `path_key` = `path` WHERE `path` IS NOT NULL AND `path_key` IS NULL;--> statement-breakpoint
CREATE INDEX `environments_host_path_key_idx` ON `environments` (`host_id`,`path_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `environments_live_path_key_idx` ON `environments` (`project_id`,`host_id`,`path_key`) WHERE "environments"."status" != 'destroyed' AND "environments"."path_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `project_sources` ADD `path_key` text;--> statement-breakpoint
UPDATE `project_sources` SET `path_key` = `path` WHERE `path` IS NOT NULL AND `path_key` IS NULL;--> statement-breakpoint
CREATE INDEX `project_sources_host_path_key_idx` ON `project_sources` (`host_id`,`path_key`);
