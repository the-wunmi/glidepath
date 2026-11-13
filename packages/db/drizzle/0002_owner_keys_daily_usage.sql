CREATE TABLE "daily_usage" (
	"day" date NOT NULL,
	"kind" text NOT NULL,
	"used" integer NOT NULL,
	CONSTRAINT "daily_usage_day_kind_pk" PRIMARY KEY("day","kind")
);
--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "owner_key_hash" text;