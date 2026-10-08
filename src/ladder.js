// The punishment ladder, shared by Discord and API apps.

import { LADDER, BAN, SEVERITY } from './config.js';

/** The punishment for an offense of `severity` when the member already has `prior` active offenses. */
export function punishmentFor(severity, prior) {
  const level = (SEVERITY[severity] ?? SEVERITY.medium).start + prior;
  return level < LADDER.length ? { ...LADDER[level], level } : { ...BAN, level: LADDER.length };
}

/** A ladder step as the API describes it: { type: 'mute' | 'ban', label, durationMs, message }. */
export function describeStep(step) {
  return step.ban
    ? { type: 'ban', label: step.label, durationMs: null, message: step.message }
    : { type: 'mute', label: step.label, durationMs: step.timeoutMs, message: step.message };
}

/** What each severity would lead to for someone with `prior` active offenses. */
export function nextPunishments(prior) {
  return Object.fromEntries(Object.keys(SEVERITY).map((sev) => [sev, describeStep(punishmentFor(sev, prior))]));
}
