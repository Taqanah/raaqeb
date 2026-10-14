/**
 * The storage module's interface: where the
 * database is, how it opens, and what the rest of the server may call. One
 * repository per aggregate in CONTEXT.md, speaking domain words; the change
 * counter's `bump()` sits on the storage itself.
 */
import type { BootSettings } from "@/server/boot/settings.ts";
import { type AuthDatabase, authDatabase } from "./auth.ts";
import {
  type CertificatesRepository,
  certificatesRepository,
} from "./certificates.ts";
import { type ChannelsRepository, channelsRepository } from "./channels.ts";
import { type ChecksRepository, checksRepository } from "./checks.ts";
import {
  type ComponentsRepository,
  componentsRepository,
} from "./components.ts";
import {
  type Backend,
  type Connection,
  closeConnection,
  executor,
} from "./connection.ts";
import { bumpChangeCounter, readChangeCounter } from "./counter.ts";
import {
  type HeartbeatsRepository,
  heartbeatsRepository,
} from "./heartbeats.ts";
import { type IncidentsRepository, incidentsRepository } from "./incidents.ts";
import {
  inspectDatabase,
  inspectPostgresUrl,
  type UrlVerdict,
  type Verdict,
} from "./inspect.ts";
import {
  type MaintenanceRepository,
  maintenanceRepository,
} from "./maintenance.ts";
import { migrateDatabase } from "./migrate.ts";
import { type MonitorsRepository, monitorsRepository } from "./monitors.ts";
import {
  type NotificationsRepository,
  notificationsRepository,
} from "./notifications.ts";
import {
  type OperatorAccountRepository,
  operatorAccountRepository,
} from "./operator.ts";
import { type OutagesRepository, outagesRepository } from "./outages.ts";
import { type PagesRepository, pagesRepository } from "./pages.ts";
import { type ConnectFailure, openPostgres } from "./postgres.ts";
import { type SettingsRepository, settingsRepository } from "./settings.ts";
import {
  type DatabaseSize,
  databaseSize,
  type FreeBytesReader,
} from "./size.ts";
import { openSqlite, sqliteFileName } from "./sqlite.ts";
import {
  type SubscriptionsRepository,
  subscriptionsRepository,
} from "./subscriptions.ts";
import { type TransferRepository, transferRepository } from "./transfer.ts";

/** The database backend chosen for this install and where it is. */
export type DatabaseLocation =
  | { backend: "sqlite"; file: string }
  | { backend: "postgres"; url: string };

/**
 * A URL names Postgres; without one, the default SQLite file counts only when
 * it already exists in the data directory; with neither this is onboarding
 * and storage opens after the database screen.
 */
export async function locateDatabase(
  settings: Pick<BootSettings, "databaseUrl" | "dataDir">
): Promise<DatabaseLocation | undefined> {
  if (settings.databaseUrl !== undefined) {
    return { backend: "postgres", url: settings.databaseUrl };
  }
  const location = defaultDatabaseLocation(settings.dataDir);
  return (await Bun.file(location.file).exists()) ? location : undefined;
}

/** The default SQLite file in the data directory: what the onboarding database screen opens when SQLite is chosen. */
export function defaultDatabaseLocation(
  dataDir: string
): Extract<DatabaseLocation, { backend: "sqlite" }> {
  return { backend: "sqlite", file: `${dataDir}/${sqliteFileName}` };
}

export interface Storage {
  /** Better Auth's adapter over this database. */
  readonly authDatabase: AuthDatabase;
  readonly backend: Backend;
  /** Advances the change counter and answers the new value. */
  bump: () => Promise<number>;
  readonly certificates: CertificatesRepository;
  /** The change counter's current value. */
  changeCounter: () => Promise<number>;
  readonly channels: ChannelsRepository;
  readonly checks: ChecksRepository;
  /** Closes the driver; the Postgres pool is closed on shutdown. */
  close: () => Promise<void>;
  readonly components: ComponentsRepository;
  readonly heartbeats: HeartbeatsRepository;
  readonly incidents: IncidentsRepository;
  readonly maintenance: MaintenanceRepository;
  readonly monitors: MonitorsRepository;
  readonly notifications: NotificationsRepository;
  readonly operatorAccount: OperatorAccountRepository;
  readonly outages: OutagesRepository;
  readonly pages: PagesRepository;
  readonly settings: SettingsRepository;
  /** The used size, the free disk under a SQLite file, and giving freed space back. */
  readonly size: DatabaseSize;
  readonly subscriptions: SubscriptionsRepository;
  /** What export and import read and write. */
  readonly transfer: TransferRepository;
}

export type OpenStorageResult =
  | { ok: true; storage: Storage; notes: string[] }
  | { ok: false; message: string };

/**
 * What the entry lends the request handler for the onboarding database
 * screen: the connection test and opening a database, over the migrations
 * folder the entry names (the build's). `open` also makes the storage the
 * one every later request carries and starts its scheduler.
 */
export interface DatabaseOpener {
  open: (location: DatabaseLocation) => Promise<OpenStorageResult>;
  /** Connects once, classifies and disconnects; the window is the screen's patience. */
  test: (url: string, options: { windowMs: number }) => Promise<UrlVerdict>;
}

/** The opener over this module's `openStorage`, handing an opened storage to `attach`. */
export function databaseOpener(
  attach: (storage: Storage) => void,
  options: OpenStorageOptions = {}
): DatabaseOpener {
  return {
    open: async (location) => {
      const opened = await openStorage(location, options);
      if (opened.ok) {
        attach(opened.storage);
      }
      return opened;
    },
    test: (url, { windowMs }) =>
      inspectPostgresUrl(url, { migrations: options.migrations, windowMs }),
  };
}

export interface OpenStorageOptions {
  /** The Postgres retry window in milliseconds. */
  connectWindowMs?: number;
  /** Reads the free disk under the SQLite file; `statfs` unless a test hands a nearly full one. */
  freeBytes?: FreeBytesReader;
  /** The folder holding one migrations folder per dialect: the build's, which the entry names, or the source tree's by default. */
  migrations?: string;
  /** The clock, for snapshot names and `updated_at`. */
  now?: () => number;
}

const failureText: Readonly<Record<ConnectFailure, string>> = {
  authentication: "authentication failed",
  database: "the database does not exist",
  malformed: "the URL is not a Postgres URL",
  refused: "connection refused",
  timeout: "connection timed out",
  tls: "TLS failed",
  unresolved: "the host name was not found",
  unknown: "the driver failed",
};

/**
 * Connects, classifies what it finds (refusing an unrecorded, newer or another
 * application's database), snapshots SQLite when migrations are pending,
 * migrates, verifies the tables, and answers the storage. A failure message
 * names the backend, the verdict or the migration, never a URL. The notes are
 * lines for the log.
 */
export async function openStorage(
  location: DatabaseLocation,
  options: OpenStorageOptions = {}
): Promise<OpenStorageResult> {
  const connected = await connect(location, options);
  if (!connected.ok) {
    return connected;
  }
  const { connection } = connected;
  const notes: string[] = [];
  try {
    const verdict = await inspectDatabase(connection, options.migrations);
    const refusal = refusalFor(verdict);
    if (refusal) {
      await closeConnection(connection);
      return { message: refusal, ok: false };
    }
    const migrated = await migrateDatabase(connection, {
      migrations: options.migrations,
      now: options.now,
    });
    if (!migrated.ok) {
      await closeConnection(connection);
      return { message: migrated.message, ok: false };
    }
    notes.push(noteFor(verdict, migrated.applied.length));
    if (migrated.snapshot) {
      notes.push(
        "snapshot taken before migrating; see snapshots/ in the data directory"
      );
    }
  } catch {
    await closeConnection(connection);
    return {
      message: `the ${location.backend} database could not be read`,
      ok: false,
    };
  }
  const run = executor(connection);
  const now = options.now ?? Date.now;
  return {
    notes,
    ok: true,
    storage: {
      authDatabase: authDatabase(connection),
      backend: connection.backend,
      bump: () => bumpChangeCounter(run),
      certificates: certificatesRepository(run),
      channels: channelsRepository(run, now),
      changeCounter: () => readChangeCounter(run),
      checks: checksRepository(run),
      close: () => closeConnection(connection),
      components: componentsRepository(run, now),
      heartbeats: heartbeatsRepository(run),
      incidents: incidentsRepository(run, now),
      maintenance: maintenanceRepository(run, now),
      monitors: monitorsRepository(run, now),
      notifications: notificationsRepository(run),
      operatorAccount: operatorAccountRepository(run),
      outages: outagesRepository(run),
      pages: pagesRepository(run, now),
      settings: settingsRepository(run, now),
      size: databaseSize(connection, run, options.freeBytes),
      subscriptions: subscriptionsRepository(run),
      transfer: transferRepository(run),
    },
  };
}

async function connect(
  location: DatabaseLocation,
  options: OpenStorageOptions
): Promise<
  { ok: true; connection: Connection } | { ok: false; message: string }
> {
  if (location.backend === "sqlite") {
    try {
      return { connection: openSqlite(location.file), ok: true };
    } catch {
      // The file is the data directory plus the fixed name; the setting is the directory.
      const dataDir = location.file.slice(0, -(sqliteFileName.length + 1));
      return {
        message: `cannot open the SQLite file (RAAQEB_DATA_DIR, ${dataDir.length} characters)`,
        ok: false,
      };
    }
  }
  const opened = await openPostgres(location.url, {
    windowMs: options.connectWindowMs,
  });
  if (!opened.ok) {
    return {
      message: `cannot connect to Postgres: ${failureText[opened.failure]} (DATABASE_URL, ${location.url.length} characters)`,
      ok: false,
    };
  }
  return { connection: opened.connection, ok: true };
}

function refusalFor(verdict: Verdict): string | undefined {
  switch (verdict.kind) {
    case "unrecorded":
      return "database holds Raaqeb tables but no migration record; refusing to touch it (restore a backup made by Raaqeb, or point DATABASE_URL at an empty database)";
    case "newer":
      return `database is Raaqeb at version ${verdict.version}, newer than this raaqeb knows; upgrade raaqeb instead`;
    case "foreign-record":
      return "database holds another application's migration record; Raaqeb cannot share it (point DATABASE_URL at an empty database)";
    default:
      return;
  }
}

function noteFor(verdict: Verdict, applied: number): string {
  switch (verdict.kind) {
    case "empty":
      return `database is empty; created it at version ${applied}`;
    case "foreign":
      return `database holds ${verdict.tables} table${verdict.tables === 1 ? "" : "s"} that ${verdict.tables === 1 ? "is" : "are"} not Raaqeb's; Raaqeb creates and touches only its own`;
    case "raaqeb":
      return applied === 0
        ? `database is Raaqeb at version ${verdict.version}; nothing to migrate`
        : `database is Raaqeb at version ${verdict.version}; migrated forward by ${applied} to ${verdict.version + applied}`;
    default:
      return `database verdict: ${verdict.kind}`;
  }
}
