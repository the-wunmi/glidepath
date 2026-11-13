ALTER TABLE "plans" ADD COLUMN "launched_token" text;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "founder_allocation" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "enrolled" numeric(78, 0) DEFAULT '0' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "plans_launched_token" ON "plans" USING btree ("launched_token");