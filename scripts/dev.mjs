import { spawn } from "node:child_process";
import { nodeFlags } from "./flags.mjs";

const child = spawn(process.execPath, ["--env-file=.env", ...nodeFlags(), "src/index.ts"], {
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
