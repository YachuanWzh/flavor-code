const HEX_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{6})$/;
const RGB_PATTERN = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)$/;

/**
 * Normalizes a CSS color to lowercase #rrggbb. Returns undefined for transparent
 * or unparsable values so callers can skip them instead of treating them as black.
 */
export function normalizeColor(input: string): string | undefined {
  const value = input.trim().toLowerCase();
  if (value === "" || value === "transparent") return undefined;
  const hex = HEX_PATTERN.exec(value);
  if (hex !== null) {
    const digits = hex[1]!;
    const expanded = digits.length === 3 ? digits.split("").map((part) => part + part).join("") : digits;
    return `#${expanded}`;
  }
  const rgb = RGB_PATTERN.exec(value);
  if (rgb !== null) {
    const alpha = rgb[4] === undefined ? 1 : Number(rgb[4]);
    if (!Number.isFinite(alpha) || alpha <= 0) return undefined;
    const channels = [rgb[1]!, rgb[2]!, rgb[3]!].map((channel) => Math.min(255, Number(channel)));
    return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
  }
  return undefined;
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

/** sRGB [0,255] channel to linear-light value. */
function linearize(channel: number): number {
  const scaled = channel / 255;
  return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

/** Converts a normalized hex color to CIE Lab (D65 illuminant). */
export function hexToLab(hex: string): [number, number, number] {
  const channels = hexToRgb(hex);
  const r = linearize(channels[0]);
  const g = linearize(channels[1]);
  const b = linearize(channels[2]);
  // sRGB -> XYZ (D65)
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 color difference between two normalized hex colors. */
export function deltaE76(left: string, right: string): number {
  const a = normalizeColor(left);
  const b = normalizeColor(right);
  if (a === undefined || b === undefined) {
    throw new Error(`Cannot compare unparseable colors: ${left} / ${right}`);
  }
  if (a === b) return 0;
  const [l1, a1, b1] = hexToLab(a);
  const [l2, a2, b2] = hexToLab(b);
  return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
}
