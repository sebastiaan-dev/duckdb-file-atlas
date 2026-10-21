-- Optional, separate from churn: 1,500 reproducible 8-KiB strings (~12 MiB).
-- force_compression is a diagnostic knob, not a production recommendation.
SET force_compression = 'uncompressed';
CREATE TABLE t AS
SELECT i AS id, repeat(md5(i::VARCHAR), 256) AS payload
FROM range(1500) r(i) ORDER BY i;
CHECKPOINT;
