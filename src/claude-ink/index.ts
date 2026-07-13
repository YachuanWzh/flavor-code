// @ts-nocheck
import { useMemo } from "react";

export { default as Box } from "./components/Box.js";
export { default as Text } from "./components/Text.js";
export { default as ScrollBox } from "./components/ScrollBox.js";
export type { ScrollBoxHandle } from "./components/ScrollBox.js";
export { AlternateScreen } from "./components/AlternateScreen.js";
export { default as useApp } from "./hooks/use-app.js";
export { default as useInput } from "./hooks/use-input.js";
export type { Key } from "./events/input-event.js";
export { default as render, renderSync } from "./root.js";
export type { Instance, RenderOptions } from "./root.js";

export function useStdout(): { stdout: NodeJS.WriteStream } {
  return useMemo(() => ({ stdout: process.stdout }), []);
}
