import { spawn } from "node:child_process";

/** POSIX callers must spawn the root in its own process group (detached=true). */
export async function terminateProcessTree(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const child = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { shell: false, windowsHide: true });
      const finish = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(finish, 5_000);
      timer.unref();
      child.once("error", finish);
      child.once("close", finish);
    });
    try { process.kill(pid); } catch { /* Already exited. */ }
  } else {
    try { process.kill(-pid, "SIGTERM"); }
    catch { try { process.kill(pid, "SIGTERM"); } catch { /* Already exited. */ } }
    await new Promise((resolve) => setTimeout(resolve, 250));
    try { process.kill(-pid, "SIGKILL"); }
    catch { try { process.kill(pid, "SIGKILL"); } catch { /* Already exited. */ } }
  }
}
