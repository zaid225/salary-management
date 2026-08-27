/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("./src", import.meta.url));
// The zod schemas are shared with the Worker, not duplicated - design
// spec §6: one validation source, three entry points.
const shared = fileURLToPath(new URL("../hono-worker/src/schemas", import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": src, "@shared": shared },
  },
  build: {
    rollupOptions: {
      output: {
        // Recharts and Clerk are the two heavy dependencies and neither
        // changes when app code does - splitting them keeps the app chunk
        // small and cacheable across deploys.
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          clerk: ["@clerk/clerk-react"],
          charts: ["recharts"],
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    globals: true,
    // The default forks pool times out spawning workers on Windows here;
    // threads start reliably and these tests share no state.
    pool: "threads",
    testTimeout: 20_000,
  },
});
