import type { ForgeConfig } from "@electron-forge/shared-types";
import { VitePlugin } from "@electron-forge/plugin-vite";

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: "Agent Workbench",
    executableName: "agent-workbench",
  },
  rebuildConfig: {},
  makers: [
    { name: "@electron-forge/maker-squirrel", config: {} },
    { name: "@electron-forge/maker-zip", config: {} },
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: "src/main/electron-main.ts",
          config: "vite.main.config.ts",
          target: "main",
        },
        {
          entry: "src/main/preload.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
        {
          entry: "src/renderer/index.tsx",
          config: "vite.renderer.config.ts",
          target: "renderer",
        },
      ],
      renderer: [{ name: "main_window", config: "vite.renderer.config.ts" }],
    }),
  ],
};

export default config;
