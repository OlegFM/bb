import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defineWorkspaceTestConfig,
  sharedWorkerProjects,
} from "../../vitest.shared.js";

export default defineWorkspaceTestConfig({
  test: {
    silent: "passed-only",
    env: {
      BB_DATA_DIR: join(tmpdir(), "bb-host-daemon-test"),
      BB_SERVER_URL: "http://127.0.0.1:49161",
      BB_HOST_DAEMON_PORT: "49162",
    },
    testTimeout: 15_000,
    projects: sharedWorkerProjects({
      pkgDir: __dirname,
      name: "@bb/host-daemon",
      include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    }),
  },
});
