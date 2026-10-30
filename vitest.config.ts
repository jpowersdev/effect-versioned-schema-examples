import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The tests start real HTTP listeners and child processes.
    testTimeout: 60_000
  }
})
