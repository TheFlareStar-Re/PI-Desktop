import { app } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";

export function windowsIconPath(): string | undefined {
  if (process.platform !== "win32") return undefined;

  const resourceRoot = app.isPackaged
    ? process.resourcesPath
    : join(app.getAppPath(), "build");
  const iconPath = join(resourceRoot, app.isPackaged ? "app-icon.ico" : "icon.ico");
  return existsSync(iconPath) ? iconPath : undefined;
}
