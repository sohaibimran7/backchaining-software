/**
 * The method registry. This is the only place the app learns which
 * calculation methods exist. Add yours to the array below.
 */
import { localAdditive, twoChances } from './localAdditive';
import { structureDiagnostic } from './structureDiagnostic';
import type { CalculationMethod } from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const methods: CalculationMethod<any>[] = [structureDiagnostic, localAdditive, twoChances];

export const DEFAULT_METHOD_ID = structureDiagnostic.id;

export function listMethods(): CalculationMethod<unknown>[] {
  return methods;
}

export function getMethod(id: string): CalculationMethod<unknown> | undefined {
  return methods.find((m) => m.id === id);
}

/** For tests and plugins: register an extra method at runtime. */
export function registerMethod(method: CalculationMethod<any>): void {
  if (methods.some((m) => m.id === method.id)) throw new Error(`A calculation method with id "${method.id}" is already registered`);
  methods.push(method);
}

/** Validates stored settings for a method, falling back to its defaults for anything missing. */
export function resolveSettings(method: CalculationMethod<unknown>, stored: unknown): { ok: true; settings: unknown } | { ok: false; problems: string[] } {
  const merged = { ...(method.defaultSettings as object), ...((stored as object | undefined) ?? {}) };
  const parsed = method.settingsSchema.safeParse(merged);
  if (parsed.success) return { ok: true, settings: parsed.data };
  return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
}
