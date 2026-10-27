const { VitePlugin } = require("@electron-forge/plugin-vite");

/** @type {import("@electron-forge/shared-types").ForgeConfig} */
module.exports = {
  packagerConfig: {
    asar: true,
    name: "agent-home",
    executableName: "agent-home",
  },
  rebuildConfig: {},
  makers: [
    { name: "@electron-forge/maker-squirrel", config: {} },
    { name: "@electron-forge/maker-zip", config: {} },
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: "src/main/electron-main.ts", config: "vite.main.config.ts", target: "main" },
        { entry: "src/main/preload.ts", config: "vite.preload.config.ts", target: "preload" },
      ],
      renderer: [{ name: "main_window", config: "vite.renderer.config.ts" }],
    }),
  ],
};
