import {
  appendSessionHostFailure,
  runSessionHost,
} from "../lib/dev-app-launcher.js";

const [logPath, command, ...args] = process.argv.slice(2);
if (logPath === undefined || command === undefined) {
  process.stderr.write(
    "Usage: run-dev-app-session-host <logPath> <command> [args...]\n",
  );
  process.exit(2);
}

runSessionHost({ args, command, cwd: process.cwd(), env: process.env, logPath })
  .then((code) => {
    process.exit(code);
  })
  .catch(async (error: unknown) => {
    await appendSessionHostFailure({
      logPath,
      message: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
