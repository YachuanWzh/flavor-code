function terminalName(): string | null {
  if (process.env.WT_SESSION) return "windows-terminal";
  if (process.env.TERM_PROGRAM) return process.env.TERM_PROGRAM.toLowerCase();
  if (process.env.TERM?.includes("kitty")) return "kitty";
  return null;
}
export const env = { terminal: terminalName() };
