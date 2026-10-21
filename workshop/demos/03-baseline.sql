-- No indexes: isolate column storage, checkpoint metadata and free blocks.
CREATE TABLE t AS
SELECT i AS id, repeat(md5(i::VARCHAR), 2) AS payload
FROM range(300000) r(i) ORDER BY i;
CHECKPOINT;
