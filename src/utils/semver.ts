// @ts-nocheck
import { gt as semverGt, gte as semverGte, valid as semverValid } from "semver";
export function gte(a: string, b: string): boolean { return semverGte(a, b, { loose: true }); }
export function gt(a: string, b: string): boolean { return semverGt(a, b, { loose: true }); }
export function isValidVersion(value: string): boolean { return semverValid(value, { loose: true }) !== null; }
