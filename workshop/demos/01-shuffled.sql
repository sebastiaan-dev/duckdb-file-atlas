-- hash() is deterministic for this binary, NOT a cross-version ordering contract.
-- The id tie-breaker makes hash collisions unambiguous. No random() or seed.
CREATE TABLE t AS
SELECT i AS id, (i % 1000)::INTEGER AS value
FROM range(300000) r(i)
ORDER BY hash(i), i;
CHECKPOINT;
