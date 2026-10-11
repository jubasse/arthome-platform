import type { MigrationInterface, QueryRunner } from 'typeorm';

import {
  INCIDENT_CAUSES,
  INCIDENT_KINDS,
  INCIDENT_TRIGGERS,
  RUN_STATES,
  RunState,
} from '@arthome/core';

function oneOf(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

/**
 * The run desk (PS1): a run per date, its stream keys (a digest per generation, never the key) and
 *   its incidents, one open at a time. The two partial indexes are the sweeper's passes'; PS5's
 *   recording pass reads `run_live` too.
 */
export class Run1791636564435 implements MigrationInterface {
  name = 'Run1791636564435';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE run (
        id uuid PRIMARY KEY,
        date_id uuid NOT NULL UNIQUE,
        channel_id uuid NOT NULL,
        state text NOT NULL CHECK (state IN (${oneOf(RUN_STATES)})),
        stream_path text NOT NULL UNIQUE,
        ingest_protocol text NOT NULL CHECK (ingest_protocol IN ('rtmps', 'srt', 'whip')),
        monitor_path text NOT NULL CHECK (monitor_path IN ('whep', 'll_hls')),
        technical_check_passed_at timestamptz NULL,
        started_at timestamptz NULL,
        ended_at timestamptz NULL,
        publisher_online_since timestamptz NULL,
        publisher_lost_at timestamptz NULL,
        after_grace_period boolean NOT NULL DEFAULT false,
        version integer NOT NULL CHECK (version >= 1),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK ((state = '${RunState.ENDED}') = (ended_at IS NOT NULL))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_run_publisher_lost ON run (publisher_lost_at)
       WHERE state = '${RunState.ON_AIR}' AND publisher_online_since IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX run_live ON run (date_id)
       WHERE state IN ('${RunState.ON_AIR}', '${RunState.INTERRUPTED}')
    `);

    await queryRunner.query(`
      CREATE TABLE stream_key (
        run_id uuid NOT NULL REFERENCES run (id),
        generation integer NOT NULL CHECK (generation >= 1),
        digest text NOT NULL UNIQUE,
        created_at timestamptz NOT NULL,
        retired_at timestamptz NULL,
        PRIMARY KEY (run_id, generation)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX stream_key_live ON stream_key (run_id) WHERE retired_at IS NULL
    `);

    await queryRunner.query(`
      CREATE TABLE incident (
        id uuid PRIMARY KEY,
        run_id uuid NOT NULL REFERENCES run (id),
        date_id uuid NOT NULL,
        kind text NOT NULL CHECK (kind IN (${oneOf(INCIDENT_KINDS)})),
        cause text NOT NULL CHECK (cause IN (${oneOf(INCIDENT_CAUSES)})),
        trigger text NOT NULL CHECK (trigger IN (${oneOf(INCIDENT_TRIGGERS)})),
        message_language text NULL,
        message_text text NULL CHECK (char_length(message_text) <= 400),
        raised_at timestamptz NOT NULL,
        raised_by uuid NULL,
        resolved_at timestamptz NULL,
        resolved_by uuid NULL,
        CHECK ((message_language IS NULL) = (message_text IS NULL))
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX incident_open ON incident (run_id) WHERE resolved_at IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE incident');
    await queryRunner.query('DROP TABLE stream_key');
    await queryRunner.query('DROP TABLE run');
  }
}
