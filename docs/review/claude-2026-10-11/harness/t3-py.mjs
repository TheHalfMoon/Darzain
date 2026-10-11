import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const py = `import subprocess,sys,time
c=subprocess.Popen(['ffmpeg','-hide_banner','-nostdin','-v','quiet','-f','lavfi','-i','testsrc2=s=640x360:r=30:d=600','-c:v','libx264','-preset','veryfast','-threads','1','-f','null','-'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
open(sys.argv[1],'w').write(str(c.pid))
time.sleep(600)`;
const w = spawn("python", ["-I", "-c", py, process.argv[2] + ".ff"], { windowsHide: true, stdio: "ignore" });
writeFileSync(process.argv[2], JSON.stringify({ node: process.pid, worker: w.pid }));
setInterval(() => {}, 1000);
