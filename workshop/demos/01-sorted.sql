-- Predict: repeated adjacent values change codec choices and zonemap ranges.
-- Compare with 01-shuffled.sql: exactly the same 300,000 (id, value) pairs.
CREATE TABLE t AS
SELECT i AS id, (i % 1000)::INTEGER AS value
FROM range(300000) r(i)
ORDER BY value, id;
CHECKPOINT;
