-- Exactly the same values as 03-overflow-uncompressed.sql.
-- Forced codecs can fall back for unsupported types (e.g. id or validity).
SET force_compression = 'zstd';
CREATE TABLE t AS
SELECT i AS id, repeat(md5(i::VARCHAR), 256) AS payload
FROM range(1500) r(i) ORDER BY i;
CHECKPOINT;
