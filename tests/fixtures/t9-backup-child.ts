// A stand-in service for crash tests: holds the service lock, opens the
// workspace and starts a backup whose database copy completes, then reports
// and waits to be killed before the media and the manifest are written.
import { ProjectStore } from "../../core/store.ts";
import { acquireServiceLock } from "../../core/service-lock.ts";
import { backupWorkspace } from "../../core/recovery.ts";

const [root, home] = process.argv.slice(2);
await acquireServiceLock(root);
const store = new ProjectStore(root);
await store.initialize();
await backupWorkspace(
  {
    root: store.root,
    get reservedBytes() {
      return store.reservedBytes;
    },
    holdObjects: () => store.holdObjects(),
    backupDatabase: async (destination: string) => {
      await store.backupDatabase(destination);
      process.send?.("copied");
      // Stay alive, mid-backup, until killed.
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    },
  },
  home,
);
