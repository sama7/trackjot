import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Unit tests only. These must never touch a database.
 * Database-backed tests live in vitest.integration.config.ts and run against a
 * disposable local or CI database.
 */
export default defineConfig({
  // Mirror the `@/*` path alias from tsconfig.json; Vitest does not read it.
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "app/**/*.test.ts", "app/**/*.test.tsx", "components/**/*.test.tsx"],
    exclude: ["**/node_modules/**", "tests/integration/**", "tests/e2e/**"],
  },
});
