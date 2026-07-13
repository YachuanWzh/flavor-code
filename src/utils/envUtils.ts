export function isEnvTruthy(value: string | boolean | undefined): boolean {
  if (typeof value === "boolean") return value;
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}
