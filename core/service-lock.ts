import { DatabaseSync } from "node:sqlite";
import { safePath } from "./paths.ts";
import { CommandError } from "./command/errors.ts";

// One service per workspace. SQLite's exclusive locking mode holds an OS file
// lock (LockFileEx on Windows, fcntl on POSIX) for the connection's lifetime;
// the operating system releases it when the process dies, so a crash never
// leaves a lock that must be deleted by hand. The file's contents are only
// diagnostic metadata.
export async function acquireServiceLock(root: string) {
  const db = new DatabaseSync(await safePath(root, "service.lock"));
  try {
    db.exec(
      "PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = MEMORY;",
    );
    db.exec("BEGIN EXCLUSIVE");
    db.exec(
      "CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY CHECK(id = 1), pid INTEGER NOT NULL, started TEXT NOT NULL)",
    );
    db.prepare(
      "INSERT INTO owner(id, pid, started) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, started = excluded.started",
    ).run(process.pid, new Date().toISOString());
    db.exec("COMMIT");
  } catch (e) {
    db.close();
    if (e instanceof Error && /locked|busy/i.test(e.message))
      throw new CommandError(
        "BUSY",
        "Another Yamakan service already owns this workspace.",
      );
    throw e;
  }
  return { release: () => db.close() };
}
