-- Remove the first default-sized row-group range AND scatter deletes after it.
-- 122880 is a workload boundary, not a promise about another build's row groups.
DELETE FROM t WHERE id < 122880 OR id % 4 = 0;
CHECKPOINT;
-- 132,840 live rows remain; checkpoint may compact/rewrite some stored spans.
