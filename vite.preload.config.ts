import { defineConfig } from "vite";
// eslint-disable-next-line @typescript-eslint/no-var-requires
import builtinModules from "builtin-modules";

export default defineConfig({
  build: {
    rollupOptions: {
      external: ["electron", ...builtinModules],
    },
    emptyOutDir: false,
  },
});
