import { defineConfig } from "@vscode/test-cli";

// `npm run test:integration` downloads VS Code (cached in .vscode-test/) and runs
// test/integration/*.test.js inside a real extension host with this extension loaded.
export default defineConfig({
  files: "test/integration/**/*.test.js",
  version: process.env.VSCODE_TEST_VERSION || "stable",
  launchArgs: ["--disable-extensions", "--skip-welcome", "--skip-release-notes"],
  mocha: { ui: "tdd", timeout: 60000 },
});
