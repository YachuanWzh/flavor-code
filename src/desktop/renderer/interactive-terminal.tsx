import React, { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XtermTerminal } from "@xterm/xterm";

import type { TerminalSnapshot } from "../../terminal/service.js";
import { terminalShellName } from "./agent-workbench-models.js";

export default function InteractiveTerminal({ terminal: snapshot, onError, onDiscover }: {
  terminal: TerminalSnapshot; onError(message: string): void; onDiscover(text: string): void;
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const onErrorRef = useRef(onError);
  const onDiscoverRef = useRef(onDiscover);
  onErrorRef.current = onError;
  onDiscoverRef.current = onDiscover;
  useEffect(() => {
    const element = host.current;
    if (element === null) return;
    const terminal = new XtermTerminal({
      allowTransparency: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "bar",
      disableStdin: snapshot.state !== "running",
      drawBoldTextInBrightColors: true,
      fontFamily: "ui-monospace, Consolas, 'Cascadia Mono', monospace",
      fontSize: 12,
      lineHeight: 1.3,
      scrollback: 5_000,
      theme: {
        background: "#16222b", foreground: "#d6e4e9", cursor: "#62b7e8", cursorAccent: "#16222b",
        selectionBackground: "#315a7088", black: "#16222b", brightBlack: "#718692", blue: "#56aee0",
        brightBlue: "#82c9ef", cyan: "#58c4c7", brightCyan: "#8adadd", green: "#78c68b", brightGreen: "#9cdda9",
        magenta: "#bc8bd4", brightMagenta: "#d6a6e8", red: "#e17b77", brightRed: "#f39a96", white: "#d6e4e9",
        brightWhite: "#f4fafc", yellow: "#d6bd70", brightYellow: "#ead58e",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);
    let disposed = false;
    let reading = false;
    let cursor = 0;
    let lastSize = "";
    let writeTail: Promise<void> = Promise.resolve();
    const report = (error: unknown) => { if (!disposed) onErrorRef.current(errorText(error)); };
    const resize = () => {
      if (disposed || element.clientWidth === 0 || element.clientHeight === 0) return;
      try {
        fit.fit();
        const size = `${terminal.cols}x${terminal.rows}`;
        if (size === lastSize) return;
        lastSize = size;
        void window.flavorDesktop.resizeTerminal(snapshot.id, terminal.cols, terminal.rows).catch(report);
      } catch (error) { report(error); }
    };
    const read = async () => {
      if (disposed || reading) return;
      reading = true;
      try {
        const next = await window.flavorDesktop.readTerminal(snapshot.id, cursor);
        if (disposed) return;
        cursor = next.cursor;
        if (next.output.length > 0) {
          onDiscoverRef.current(next.output);
          terminal.write(next.output);
        }
      } catch (error) { report(error); }
      finally { reading = false; }
    };
    const input = terminal.onData((data) => {
      writeTail = writeTail.then(() => window.flavorDesktop.writeTerminal(snapshot.id, data)).catch((error) => { report(error); });
    });
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(resize);
    observer?.observe(element);
    const timer = window.setInterval(() => { void read(); }, 120);
    resize();
    void read();
    terminal.focus();
    return () => {
      disposed = true;
      window.clearInterval(timer);
      observer?.disconnect();
      input.dispose();
      void writeTail.catch(() => undefined);
      fit.dispose();
      terminal.dispose();
    };
  }, [snapshot.id, snapshot.state]);
  return <div className="terminal-emulator" ref={host} aria-label={`${terminalShellName(snapshot.shell)} 交互终端`} />;
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
