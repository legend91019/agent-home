import * as path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  cache: {
    dir: path.resolve(__dirname, "node_modules/.vitest-cache"),
  },
  test: {
    environment: "node",
    globals: true,
    include: ["tests/**/*.test.ts"],
    pool: "forks",
    poolOptions: {
      forks: {
        // 单进程避免沙箱文件代理在并发写缓存时的 EPERM 竞态。
        singleFork: true,
      },
    },
    deps: {
      // 彻底关闭依赖预打包，避免 SSR 缓写在沙箱临时目录被拦截。
      optimizer: {
        enabled: false,
        web: { enabled: false },
        ssr: { enabled: false },
      },
    },
  },
});
