/** The only place the app learns which aggregation methods exist. Add yours to the array. */
import { equalMean, logOdds, median, noPooling, rangeWeighted } from './methods';
import type { AggregationMethod } from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const methods: AggregationMethod<any>[] = [noPooling, equalMean, median, rangeWeighted, logOdds];

export function listAggregations(): AggregationMethod<unknown>[] {
  return methods;
}
export function getAggregation(id: string): AggregationMethod<unknown> | undefined {
  return methods.find((m) => m.id === id);
}
export function registerAggregation(method: AggregationMethod<any>): void {
  if (methods.some((m) => m.id === method.id)) throw new Error(`An aggregation method with id "${method.id}" is already registered`);
  methods.push(method);
}
export function resolveAggregationSettings(method: AggregationMethod<unknown>, stored: unknown): { ok: true; settings: unknown } | { ok: false; problems: string[] } {
  const merged = { ...(method.defaultSettings as object), ...((stored as object | undefined) ?? {}) };
  const parsed = method.settingsSchema.safeParse(merged);
  if (parsed.success) return { ok: true, settings: parsed.data };
  return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
}
