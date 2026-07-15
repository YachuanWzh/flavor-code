// @ts-nocheck
import { useContext, useEffect } from 'react'
import stripAnsi from 'strip-ansi'
import { OSC, osc } from '../termio/osc.js'
import { TerminalWriteContext } from '../useTerminalNotification.js'

/**
 * Declaratively set the terminal tab/window title.
 *
 * Pass a string to set the title. ANSI escape sequences are stripped
 * automatically so callers don't need to know about terminal encoding.
 * Pass `null` to opt out — the hook becomes a no-op and leaves the
 * terminal title untouched.
 *
 * Writes OSC 0 (set title+icon) via Ink's stdout. Works in VS Code,
 * Windows Terminal, and all modern terminal emulators.
 */
export function useTerminalTitle(title: string | null): void {
  const writeRaw = useContext(TerminalWriteContext)

  useEffect(() => {
    if (title === null || !writeRaw) return

    const clean = stripAnsi(title)

    writeRaw(osc(OSC.SET_TITLE_AND_ICON, clean))
  }, [title, writeRaw])
}
