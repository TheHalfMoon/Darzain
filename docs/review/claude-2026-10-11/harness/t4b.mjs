import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
writeFileSync("t4/ar2.txt", "مرحبا بالعالم!");
execFileSync("ffmpeg", ["-hide_banner","-v","error","-y","-f","lavfi","-i","color=c=black:s=600x120",
  "-vf", `drawtext=fontfile='font.ttf':textfile='ar2.txt':expansion=none:fontsize=52:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2`,
  "-frames:v","1","punct.png"], { cwd: "t4" });
