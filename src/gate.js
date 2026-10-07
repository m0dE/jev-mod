// The quick first check. Messages wait up to `delayMs` to be bundled into one Jev request
// that asks only "could this break a rule?". Most chat comes back clearly fine and never
// needs the full check, which is about 10x the tokens per message.

import { jevGateRequest } from './jev.js';

export function createGate({ ask, delayMs = 2000, maxBatch = 20 }) {
  let queue = [];
  let timer = null;

  async function flush() {
    clearTimeout(timer);
    timer = null;
    const batch = queue;
    queue = [];
    if (!batch.length) return;
    // `ask` returns null when Jev fails; then every message goes on to the full check.
    const answers = await ask(jevGateRequest(batch));
    batch.forEach((item, i) => item.resolve(answers?.[`m${i}`]?.noul ?? null));
  }

  return {
    /** Resolves with the probability (0-1) the message breaks a rule, or null if Jev couldn't say. */
    check(content, customRules = []) {
      return new Promise((resolve) => {
        queue.push({ content, customRules, resolve });
        if (queue.length >= maxBatch) flush();
        else timer ??= setTimeout(flush, delayMs);
      });
    },
  };
}
