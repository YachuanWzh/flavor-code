// @ts-nocheck
import { gte as semverGte } from "semver";
export function gte(a: string, b: string): boolean { return semverGte(a, b, { loose: true }); }
