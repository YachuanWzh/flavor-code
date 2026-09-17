/**
 * Parses agent-supplied element target strings into typed locators.
 * Supported syntax (md_docs/todo.md section 5, element-resolver):
 *   @12 / ref=12          snapshot ref
 *   loc=css:...           explicit CSS
 *   loc=role:button[name='Save']
 *   loc=href:/docs
 *   text=Sign in
 *   xpath=//div[1]
 *   div.primary           bare CSS (compat input)
 */

import { BrowserError } from "./types.js";

export type BrowserLocator =
  | { kind: "ref"; ref: number }
  | { kind: "css"; selector: string }
  | { kind: "role"; role: string; name?: string }
  | { kind: "href"; value: string }
  | { kind: "text"; value: string }
  | { kind: "xpath"; expression: string };

const REF_RE = /^@(?:ref=)?([0-9]{1,7})$|^ref=([0-9]{1,7})$/;
const ROLE_RE = /^([A-Za-z][\w-]*)?(?:\[(?:name|accessible-name)=(['"])(.*?)\2\])?$/;
const MAX_PART_LENGTH = 1_000;

function bad(message: string): never {
  throw new BrowserError("bad-locator", message, true);
}

export function parseLocator(raw: string): BrowserLocator {
  const input = raw.trim();
  if (input.length === 0) bad("Empty locator");
  if (input.length > 2_048) bad("Locator too long");

  const ref = REF_RE.exec(input);
  if (ref) {
    const digits = ref[1] ?? ref[2] ?? "";
    const value = Number(digits);
    if (!Number.isSafeInteger(value) || value < 1) bad(`Invalid ref "${input}"`);
    return { kind: "ref", ref: value };
  }

  if (input.startsWith("loc=")) {
    const rest = input.slice(4);
    const colon = rest.indexOf(":");
    if (colon <= 0) bad(`Unknown locator scheme in "${input}"`);
    const scheme = rest.slice(0, colon).toLowerCase();
    const body = capped(rest.slice(colon + 1), input);
    switch (scheme) {
      case "css":
        return locatorCss(body, input);
      case "role":
        return locatorRole(body, input);
      case "href":
        if (body === "") bad("href locator requires a value");
        return { kind: "href", value: body };
      default:
        bad(`Unknown locator scheme "${scheme}"`);
    }
  }

  if (input.startsWith("text=")) {
    const value = capped(input.slice(5), input);
    if (value === "") bad("text locator requires a value");
    return { kind: "text", value };
  }

  if (input.startsWith("xpath=")) {
    const expression = capped(input.slice(6), input);
    if (!expression.startsWith("/") && !expression.startsWith(".") && !expression.startsWith("(")) {
      bad("xpath locator must start with /, ./ or (");
    }
    return { kind: "xpath", expression };
  }

  // Bare input is treated as CSS for compatibility.
  return locatorCss(input, input);
}

function locatorCss(selector: string, input: string): BrowserLocator {
  const trimmed = selector.trim();
  if (trimmed === "") bad(`Empty CSS selector in "${input}"`);
  return { kind: "css", selector: trimmed };
}

function locatorRole(body: string, input: string): BrowserLocator {
  const match = ROLE_RE.exec(body.trim());
  if (!match || (!match[1] && match[3] === undefined)) {
    bad(`Invalid role locator "${input}"`);
  }
  const role = match[1];
  const name = match[3];
  if (role === undefined) bad(`Invalid role locator "${input}"`);
  return name === undefined || name === "" ? { kind: "role", role } : { kind: "role", role, name };
}

function capped(value: string, input: string): string {
  if (value.length > MAX_PART_LENGTH) bad(`Locator segment too long in "${input}"`);
  return value.trim();
}

/** Formats a locator back to its canonical string form (for logs and UI). */
export function formatLocator(locator: BrowserLocator): string {
  switch (locator.kind) {
    case "ref":
      return `@${locator.ref}`;
    case "css":
      return `loc=css:${locator.selector}`;
    case "role":
      return `loc=role:${locator.name === undefined ? locator.role : `${locator.role}[name='${locator.name}']`}`;
    case "href":
      return `loc=href:${locator.value}`;
    case "text":
      return `text=${locator.value}`;
    case "xpath":
      return `xpath=${locator.expression}`;
  }
}
