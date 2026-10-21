-- Same rows and order as 02-append.sql, one CTAS and one final checkpoint.
CREATE TABLE t AS
SELECT i AS id, (i % 1000)::INTEGER AS value, md5(i::VARCHAR) AS payload
FROM range(300000) r(i)
ORDER BY i;
CHECKPOINT;
