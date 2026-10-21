-- New keys, not restoration of deleted records. 282,840 live rows afterwards.
INSERT INTO t
SELECT i AS id, repeat(md5(i::VARCHAR), 2) AS payload
FROM range(300000, 450000) r(i) ORDER BY i;
CHECKPOINT;
-- Compare free lists and physical IDs to earlier snapshots. Reuse is permitted,
-- but exact reuse, shrinkage and retention of tombstones are not guaranteed.
