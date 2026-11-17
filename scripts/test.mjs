import { spawn } from "node:child_process";
import { nodeFlags } from "./flags.mjs";

const child = spawn(process.execPath, ["--env-file=.env", ...nodeFlags(), "--test", "src/dates.test.ts", "src/dates-model.test.ts", "src/prior.test.ts"], {
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
