/**
 * Історія у сховищі часових рядів TimescaleDB:
 * - telemetry — кожне вимірювання так, як воно прийшло від станції (разом із запізнілими);
 * - twin_state_changes — кожна зміна стану двійника.
 * Записи накопичуються в пам’яті й записуються пакетами раз на flushIntervalMs.
 */
import pg from 'pg';
import { config } from '../config.ts';
import type { IncomingTelemetry } from './ingest.ts';
import type { StateUpdate } from './state-store.ts';

const SCHEMA = `
  CREATE EXTENSION IF NOT EXISTS timescaledb;

  CREATE TABLE IF NOT EXISTS telemetry (
    time         TIMESTAMPTZ      NOT NULL,  -- час вимірювання на станції
    sensor_id    TEXT             NOT NULL,
    value_number DOUBLE PRECISION,           -- числові показання
    value_text   TEXT,                       -- стан, режим, сухий хід
    unit         TEXT             NOT NULL,
    seq          INTEGER          NOT NULL,
    received_at  TIMESTAMPTZ      NOT NULL,  -- коли отримав сервіс синхронізації
    late         BOOLEAN          NOT NULL   -- запізніле (не потрапило в потік стану)
  );
  SELECT create_hypertable('telemetry', by_range('time'), if_not_exists => TRUE);
  CREATE INDEX IF NOT EXISTS telemetry_sensor_time_idx ON telemetry (sensor_id, time DESC);

  CREATE TABLE IF NOT EXISTS twin_state_changes (
    time    TIMESTAMPTZ NOT NULL,  -- коли змінився стан двійника
    version INTEGER     NOT NULL,
    path    TEXT        NOT NULL,  -- outlet.pressure, pump1.vibrationLevel, stale…
    value   JSONB,                 -- нове значення (число, рядок, логічне або null)
    reason  TEXT        NOT NULL   -- event / threshold / periodic
  );
  SELECT create_hypertable('twin_state_changes', by_range('time'), if_not_exists => TRUE);
  CREATE INDEX IF NOT EXISTS twin_state_changes_path_time_idx ON twin_state_changes (path, time DESC);
`;

interface TelemetryRow {
  time: string;
  sensorId: string;
  valueNumber: number | null;
  valueText: string | null;
  unit: string;
  seq: number;
  receivedAt: string;
  late: boolean;
}

interface StateChangeRow {
  time: string;
  version: number;
  path: string;
  value: string;
  reason: string;
}

/** Найбільша кількість незаписаних рядків: якщо база довго недоступна, найстаріші відкидаються. */
const MAX_PENDING_ROWS = 100_000;

export class HistoryWriter {
  private readonly pool = new pg.Pool({ connectionString: config.database.url });
  private telemetryRows: TelemetryRow[] = [];
  private stateRows: StateChangeRow[] = [];
  private flushing = false;

  constructor() {
    // Якщо база впала, бездіяльне з’єднання пулу повідомляє про помилку.
    // Без цього обробника Node.js завершив би весь сервіс; натомість просто чекаємо відновлення.
    this.pool.on('error', (error) => console.error(`TimescaleDB: з’єднання втрачено (${error.message})`));
  }

  /** Створює таблиці й гіпертаблиці, якщо їх ще немає. */
  async init(): Promise<void> {
    await this.pool.query(SCHEMA);
    console.log('TimescaleDB: схему перевірено');
  }

  addTelemetry(item: IncomingTelemetry, late: boolean): void {
    const { message } = item;
    this.telemetryRows.push({
      time: message.timestamp,
      sensorId: message.sensorId,
      valueNumber: typeof message.value === 'number' ? message.value : null,
      valueText: typeof message.value === 'number' ? null : String(message.value),
      unit: message.unit,
      seq: message.seq,
      receivedAt: new Date(item.receivedAt).toISOString(),
      late,
    });
  }

  addStateUpdate({ state, changes }: StateUpdate): void {
    for (const change of changes) {
      this.stateRows.push({
        time: state.updatedAt ?? new Date().toISOString(),
        version: state.version,
        path: change.path,
        value: JSON.stringify(change.value),
        reason: change.reason,
      });
    }
  }

  /**
   * Записує накопичене одним запитом на таблицю.
   * Якщо база недоступна, рядки повертаються в чергу й буде нова спроба при наступному записі.
   */
  async flush(): Promise<{ telemetry: number; stateChanges: number }> {
    if (this.flushing) return { telemetry: 0, stateChanges: 0 };
    this.flushing = true;

    const telemetry = this.telemetryRows;
    const stateChanges = this.stateRows;
    this.telemetryRows = [];
    this.stateRows = [];

    try {
      if (telemetry.length > 0) await this.insertTelemetry(telemetry);
      if (stateChanges.length > 0) await this.insertStateChanges(stateChanges);
      return { telemetry: telemetry.length, stateChanges: stateChanges.length };
    } catch (error) {
      console.error(`TimescaleDB: не вдалося записати історію (${(error as Error).message}), повторю пізніше`);
      this.telemetryRows = [...telemetry, ...this.telemetryRows].slice(-MAX_PENDING_ROWS);
      this.stateRows = [...stateChanges, ...this.stateRows].slice(-MAX_PENDING_ROWS);
      return { telemetry: 0, stateChanges: 0 };
    } finally {
      this.flushing = false;
    }
  }

  async close(): Promise<void> {
    await this.flush();
    await this.pool.end();
  }

  /** Пакетна вставка: кожен стовпчик передається масивом, unnest розгортає їх у рядки. */
  private async insertTelemetry(rows: TelemetryRow[]): Promise<void> {
    await this.pool.query(
      `INSERT INTO telemetry (time, sensor_id, value_number, value_text, unit, seq, received_at, late)
       SELECT * FROM unnest($1::timestamptz[], $2::text[], $3::float8[], $4::text[], $5::text[], $6::int[], $7::timestamptz[], $8::bool[])`,
      [
        rows.map((row) => row.time),
        rows.map((row) => row.sensorId),
        rows.map((row) => row.valueNumber),
        rows.map((row) => row.valueText),
        rows.map((row) => row.unit),
        rows.map((row) => row.seq),
        rows.map((row) => row.receivedAt),
        rows.map((row) => row.late),
      ],
    );
  }

  private async insertStateChanges(rows: StateChangeRow[]): Promise<void> {
    await this.pool.query(
      `INSERT INTO twin_state_changes (time, version, path, value, reason)
       SELECT * FROM unnest($1::timestamptz[], $2::int[], $3::text[], $4::jsonb[], $5::text[])`,
      [
        rows.map((row) => row.time),
        rows.map((row) => row.version),
        rows.map((row) => row.path),
        rows.map((row) => row.value),
        rows.map((row) => row.reason),
      ],
    );
  }
}
