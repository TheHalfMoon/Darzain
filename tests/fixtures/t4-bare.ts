// A script with no server: owner.run() must settle and the script must exit.
import { ProcessOwner } from "../../core/process/owner.ts";

const owner = new ProcessOwner([process.execPath]);
for (let i = 0; i < 20; i++) {
  const { code } = await owner.run({
    executable: process.execPath,
    args: ["-e", "process.stdout.write('x')"],
    cwd: process.cwd(),
  });
  if (code !== 0) process.exit(2);
}
process.stdout.write("done");
