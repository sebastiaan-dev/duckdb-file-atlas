-- Run after CHECKPOINT. This file is appended to every generated phase.
SELECT version() AS engine_version;
SELECT name, value FROM duckdb_settings()
WHERE name IN ('threads', 'preserve_insertion_order', 'memory_limit',
               'checkpoint_threshold', 'force_compression',
               'storage_compatibility_version', 'default_block_size')
ORDER BY name;
SELECT * FROM pragma_database_size() WHERE database_name = current_database();
SELECT count(*) AS live_rows, min(id) AS min_id, max(id) AS max_id FROM t;

-- Counts below are segment spans, NOT summed live table rows or byte lengths.
-- Keep validity separate: it commonly has Constant compression and block_id=-1.
SELECT column_name, segment_type, compression, persistent,
       count(*) AS segments, sum(count) AS stored_value_slots,
       count(DISTINCT block_id) FILTER (WHERE block_id >= 0) AS primary_blocks
FROM pragma_storage_info('t')
GROUP BY ALL ORDER BY column_name, segment_type, compression, persistent;

-- Compact physical history view, then complete raw rows (including stats).
SELECT row_group_id, min(start) AS first_slot, sum(count) AS stored_id_slots
FROM pragma_storage_info('t')
WHERE column_name = 'id' AND segment_type != 'VALIDITY'
GROUP BY row_group_id ORDER BY row_group_id;
-- SELECT * includes persistent, block_id, block_offset and, where supported,
-- additional_block_ids. Avoid hard-coding optional metadata columns.
SELECT * FROM pragma_storage_info('t')
ORDER BY row_group_id, column_id, column_path, segment_id;
