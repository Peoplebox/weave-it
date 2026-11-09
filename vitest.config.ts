import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Keeps every test away from real terminals, apps, and the developer's own settings.
    setupFiles: ["tests/setup/no-open.ts"],
  },
});
