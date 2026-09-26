import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Turn a file reference in assistant output into a terminal hyperlink. */
export function fileLinkUrl(reference: string, workspace?: string): string | undefined {
  const value = reference.trim();
  if (!value || value.startsWith("#") || /[\x00-\x1f\x7f]/u.test(value)) return undefined;
  if (value.startsWith("file://")) {
    try { return new URL(value).href; } catch { return undefined; }
  }
  if (/^[a-z][a-z\d+.-]*:/iu.test(value) && !/^[A-Za-z]:[\\/]/u.test(value)) return undefined;

  // A source location may include a line and column. Keep these out of the
  // filesystem path, while preserving the line for terminals that use it.
  const location = /^(.*?):(\d+)(?::\d+)?$/u.exec(value);
  const path = location?.[1] ?? value;
  const absolute = isAbsolute(path);
  if (!absolute && workspace === undefined) return undefined;
  const url = pathToFileURL(absolute ? path : resolve(workspace!, path));
  if (location) url.hash = `L${location[2]}`;
  return url.href;
}

export function looksLikeFilePath(value: string): boolean {
  return value.startsWith("file://") || (!/^[a-z][a-z\d+.-]*:\/\//iu.test(value)
    && /^(?:[A-Za-z]:[\\/]|\/|\.{1,2}[\\/]|[^\s/\\]+[/\\]|[^\s/\\]+\.[\w-]+(?::\d+(?::\d+)?)?$)/u.test(value));
}

/** Only recognize clear path syntax in prose; code spans can contain spaces. */
const PATH_IN_TEXT = /(^|[\s([{“‘])((?:[A-Za-z]:[\\/]|\/|\.{1,2}[\\/]|[\w.-]+\/)[^\s<>"“”‘’`]+)/gu;

export function splitFilePaths(text: string, workspace?: string): Array<{ text: string; url?: string }> {
  const parts: Array<{ text: string; url?: string }> = [];
  let cursor = 0;
  for (const match of text.matchAll(PATH_IN_TEXT)) {
    const start = match.index + match[1]!.length;
    const raw = match[2]!;
    const path = raw.replace(/[.,;!?)}\]]+$/u, "");
    const url = fileLinkUrl(path, workspace);
    if (!url || path.length === 0) continue;
    if (start > cursor) parts.push({ text: text.slice(cursor, start) });
    parts.push({ text: path, url });
    cursor = start + path.length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) });
  return parts;
}
