/**
 * Electron 主进程入口（agent-home）。
 * 职责：窗口生命周期、单实例锁、squirrel 启动处理，以及把全部 IPC 通道
 * 委托给 src/main/ipc 的 handle() —— 业务逻辑不在此处，只在边界做错误收敛。
 *
 * 注意：本文件只在安装 electron 工具链后参与构建（已排除在核心 tsconfig 之外，
 * 以免未安装 electron 类型时影响后端 typecheck）。
 */
import { app, BrowserWindow, ipcMain } from "electron";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createContext } from "./services";
import { handle } from "./ipc";
import { IPC_CHANNELS, IpcChannel } from "../shared/contracts";
import { WorkbenchError, toWorkbenchError } from "../shared/errors";

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

// squirrel 安装/卸载事件：首次启动时应尽早退出以避免重复实例。
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  if (require("electron-squirrel-startup")) app.quit();
} catch {
  /* 未打包时该依赖不存在，忽略 */
}

let mainWindow: BrowserWindow | null = null;
let trustedRendererUrl = "";

const SINGLE_INSTANCE = app.requestSingleInstanceLock();
if (!SINGLE_INSTANCE) {
  app.quit();
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 850,
    minWidth: 1024,
    minHeight: 720,
    backgroundColor: "#1e1e2e",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== trustedRendererUrl) event.preventDefault();
  });
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    trustedRendererUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL;
    void mainWindow.loadURL(trustedRendererUrl);
  } else {
    const rendererPath = path.join(__dirname, `renderer/${MAIN_WINDOW_VITE_NAME}/index.html`);
    trustedRendererUrl = pathToFileURL(rendererPath).toString();
    void mainWindow.loadFile(rendererPath);
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function registerIpc(): void {
  const ctx = createContext();
  for (const channel of IPC_CHANNELS) {
    ipcMain.handle(channel, async (event, input: unknown) => {
      try {
        if (event.sender !== mainWindow?.webContents || event.senderFrame?.url !== trustedRendererUrl) {
          throw new WorkbenchError("permission_denied", "IPC 请求不来自工作台窗口");
        }
        return await handle(ctx, channel as IpcChannel, input);
      } catch (err) {
        // 跨进程边界：只把结构化错误抛给渲染层，绝不泄露内部堆栈。
        throw toWorkbenchError(err);
      }
    });
  }
}

if (SINGLE_INSTANCE) {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    registerIpc();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
