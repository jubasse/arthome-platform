-- One database per service (README): a service owns its schema and nothing
-- reaches across. Created at first start of an empty data directory.
--
-- ⚠ Each one gets its OWN replication slot when its connector is registered —
--   `arthome_<service>_outbox`. A slot nobody consumes RETAINS THE WAL, so a
--   stopped connector makes the disk grow until it is full (data-model.md §7.4).
CREATE DATABASE notifications OWNER arthome;
CREATE DATABASE catalog OWNER arthome;
CREATE DATABASE search OWNER arthome;
