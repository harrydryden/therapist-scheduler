-- Persistent IANA timezone on User and Therapist.
--
-- Up to now the resolver fell through to the country default and (for
-- multi-zone countries like US/AU/CA) the platform default — leaving the
-- recipient seeing UK time on confirmation/reminder emails. This pair of
-- columns lets the booking agent persist the user's / therapist's actual
-- region once it has been asked, so subsequent flows quote times in the
-- right zone.
--
-- Both columns are nullable: existing rows are unaffected, and the
-- resolver continues to fall back to availability.timezone / country
-- default / platform default for rows where the agent hasn't yet
-- recorded a zone.
ALTER TABLE "users" ADD COLUMN "timezone" TEXT;
ALTER TABLE "therapists" ADD COLUMN "timezone" TEXT;
