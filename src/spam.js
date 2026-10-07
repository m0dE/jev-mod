// Spam that only shows up across messages: flooding, and the same message posted again
// and again (often across channels, by a hacked account).

import { normalize } from './rules.js';

const FLOOD = { count: 6, withinMs: 10_000 };
// Long or link-carrying messages repeated 3 times is spam; short ones ("gg", "lol") need 5.
const REPEAT = { count: 3, shortCount: 5, withinMs: 60_000, minLength: 10 };

const URL_RE = /https?:\/\/|discord\.gg\//i;
const same = (a, b) => normalize(a).replace(/\s+/g, ' ').trim() === normalize(b).replace(/\s+/g, ' ').trim();

/**
 * history: the member's earlier messages (see history.js). Returns a verdict, plus
 * `duplicates`: the earlier messages of the flood or copies, to delete as well.
 */
export function checkSpam(content, history, now = Date.now()) {
  const recent = (ms) => history.filter((h) => now - h.at <= ms);

  const burst = recent(FLOOD.withinMs);
  if (burst.length + 1 >= FLOOD.count) {
    return { violation: true, category: 'spam', severity: 'low', reason: 'Sending messages too fast', source: 'spam', standalone: true, duplicates: burst };
  }

  const copies = recent(REPEAT.withinMs).filter((h) => same(h.content, content));
  const needed = content.length >= REPEAT.minLength || URL_RE.test(content) ? REPEAT.count : REPEAT.shortCount;
  if (content.trim() && copies.length + 1 >= needed) {
    return { violation: true, category: 'spam', severity: 'medium', reason: 'Repeating the same message', source: 'spam', standalone: true, duplicates: copies };
  }

  return { violation: false, source: 'spam' };
}
