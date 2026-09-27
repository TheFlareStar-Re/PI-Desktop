import { app, type BrowserWindow } from "electron";
import { existsSync } from "node:fs";
import { APP_ID, APP_NAME } from "@pi-desktop/shared";
import { windowsIconPath } from "./windows-icon";

function isDevelopmentIdentity(): boolean {
  return process.env.PI_DESKTOP_DEV === "1" || !app.isPackaged;
}

export function windowsAppUserModelId(): string {
  return isDevelopmentIdentity() ? `${APP_ID}.dev` : APP_ID;
}

export function setWindowsWindowAppDetails(window: BrowserWindow): void {
  if (process.platform !== "win32") return;

  const portableLauncher = app.isPackaged
    ? process.env.PORTABLE_EXECUTABLE_FILE
    : undefined;
  const relaunchPath = portableLauncher && existsSync(portableLauncher)
    ? portableLauncher
    : process.execPath;
  const iconPath = portableLauncher && relaunchPath === portableLauncher
    ? portableLauncher
    : windowsIconPath();
  window.setAppDetails({
    appId: windowsAppUserModelId(),
    ...(iconPath ? { appIconPath: iconPath } : {}),
    relaunchCommand: app.isPackaged
      ? `"${relaunchPath}"`
      : `"${relaunchPath}" "${app.getAppPath()}"`,
    relaunchDisplayName: isDevelopmentIdentity()
      ? `${APP_NAME} Dev`
      : APP_NAME,
  });
}
