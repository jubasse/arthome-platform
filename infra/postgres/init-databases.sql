-- One database per service (README): a service owns its schema and nothing
-- reaches across. Created at first start of an empty data directory.
--
-- Each one gets its OWN replication slot when its connector is registered —
--   `arthome_<service>_outbox`. A slot nobody consumes RETAINS THE WAL, so a
--   stopped connector makes the disk grow until it is full (data-model.md §7.4).
CREATE DATABASE notifications OWNER arthome;
CREATE DATABASE catalog OWNER arthome;
CREATE DATABASE search OWNER arthome;

-- A SESSION LEFT IDLE INSIDE A TRANSACTION RETAINS THE WAL, exactly as an
--   unconsumed slot above does — it holds back the oldest transaction the server
--   may discard, so one forgotten `BEGIN` in a consumer grows the disk until it is
--   full. 60 s is far longer than any handler here and far shorter than a night.
--
-- SET ON THE DATABASE, NOT ON THE CLIENT, and the reason is the migration CLI:
--   it shares a service's DataSource, so a client-side statement_timeout would kill
--   a long `ALTER` or a backfill halfway. A migration that needs longer lifts these
--   for its own session with `SET LOCAL`; nothing else should need to.
ALTER DATABASE identity      SET idle_in_transaction_session_timeout = '60s';
ALTER DATABASE notifications SET idle_in_transaction_session_timeout = '60s';
ALTER DATABASE catalog       SET idle_in_transaction_session_timeout = '60s';
ALTER DATABASE search        SET idle_in_transaction_session_timeout = '60s';

ALTER DATABASE identity      SET statement_timeout = '30s';
ALTER DATABASE notifications SET statement_timeout = '30s';
ALTER DATABASE catalog       SET statement_timeout = '30s';
ALTER DATABASE search        SET statement_timeout = '30s';
