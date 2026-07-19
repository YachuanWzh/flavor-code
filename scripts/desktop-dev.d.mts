export interface DesktopDevCommand {
  command: string;
  args: [string, ...string[]];
}

export interface DesktopDevCommands {
  vite: DesktopDevCommand;
  electron: DesktopDevCommand;
}

export function createDesktopDevCommands(options?: {
  cwd?: string;
  nodePath?: string;
  platform?: NodeJS.Platform;
}): DesktopDevCommands;

export function runDesktopDev(): Promise<void>;
