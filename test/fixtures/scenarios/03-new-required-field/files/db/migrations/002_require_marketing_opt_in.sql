-- Marketing consent becomes mandatory. Existing rows are backfilled, so reads are fine,
-- but signup does not provide the new column.
ALTER TABLE customers ADD COLUMN marketing_opt_in boolean;
UPDATE customers SET marketing_opt_in = false;
ALTER TABLE customers ALTER COLUMN marketing_opt_in SET NOT NULL;
