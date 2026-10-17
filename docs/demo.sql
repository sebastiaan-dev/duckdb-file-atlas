CREATE TABLE layout_demo AS
SELECT
  i::BIGINT AS id,
  'group-' || CAST(i % 32 AS VARCHAR) AS category,
  repeat('duckdb-layout-', 4) AS payload
FROM range(200000) AS source(i);

CHECKPOINT;
