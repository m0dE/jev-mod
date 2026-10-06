// Fast keyword/pattern rules. They run on every message before the AI, catch the
// obvious stuff for free, and are the whole classifier when no API key is set.
//
// Add your own words (one per line, `#` for comments) to config/blocked-words.txt.

import fs from 'node:fs';

const PATTERNS = [
  // high severity: self-harm incitement, threats
  { category: 'toxicity', severity: 'high', reason: 'Telling someone to harm themselves',
    re: /\b(kys|kill\s*(?:ur|your)\s*self|go\s+die|end\s+(?:ur|your)\s*(?:self|life)|neck\s+yourself)\b/i },
  { category: 'threat', severity: 'high', reason: 'Threatening another member',
    re: /\b(i(?:'ll| will| am gonna|m gonna)\s+(?:kill|hurt|find|dox+)\s+(?:you|u)|i\s+know\s+where\s+you\s+live)\b/i },

  // medium: direct insults
  { category: 'rudeness', severity: 'medium', reason: 'Insulting another member',
    re: /\b(?:you(?:'re| are)?|ur|u r)\s+(?:so\s+|such\s+an?\s+|an?\s+)?(?:idiot|moron|stupid|dumb(?:ass)?|retard(?:ed)?|loser|trash|garbage|pathetic|worthless|clown|braindead)\b/i },
  { category: 'rudeness', severity: 'medium', reason: 'Hostile language',
    re: /\b(?:shut\s+(?:the\s+f\w*\s+)?up|stfu|f+u+c+k+\s+(?:you|u|off)|screw\s+you|nobody\s+(?:asked|likes\s+you))\b/i },

  // griefing: organising or bragging about ruining others' play, raids
  { category: 'griefing', severity: 'medium', reason: 'Griefing / raiding',
    re: /\b(?:let'?s|lets|gonna|going\s+to|i\s+just)\s+(?:grief|raid|wreck|destroy|burn\s+down|nuke)\b|\bgrief(?:ed|ing)?\s+(?:their|his|her|ur|your|the)\b|\braid\s+(?:this|the)\s+server\b/i },

  // negativity aimed at the community
  { category: 'negativity', severity: 'low', reason: 'Trashing the server or community',
    re: /\b(?:this|the)\s+(?:server|community|game|mods?|staff|admins?)\s+(?:is|are)\s+(?:trash|garbage|dead|shit|terrible|a\s+joke|cancer)\b|\beveryone\s+here\s+(?:is|are)\s+(?:trash|stupid|idiots|losers)\b/i },
];

function loadBlockedWords(file = 'config/blocked-words.txt') {
  try {
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Collapse common evasions: l33t-speak, dots/spaces between letters, repeated letters. */
export function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[0@]/g, 'o').replace(/[1!|]/g, 'i').replace(/3/g, 'e')
    .replace(/4/g, 'a').replace(/[5$]/g, 's').replace(/7/g, 't')
    .replace(/(\w)[.\-_*]+(?=\w)/g, '$1')
    .replace(/(.)\1{2,}/g, '$1$1');
}

export function createRuleClassifier({ blockedWords = loadBlockedWords() } = {}) {
  const blocked = blockedWords.length
    ? new RegExp(`\\b(?:${blockedWords.map(escape).join('|')})\\b`, 'i')
    : null;

  return function classifyByRules(content, { mentionCount = 0 } = {}) {
    const text = content || '';
    const norm = normalize(text);

    if (blocked && (blocked.test(text) || blocked.test(norm))) {
      return { violation: true, category: 'hate', severity: 'high', reason: 'Blocked word', source: 'rules' };
    }
    for (const p of PATTERNS) {
      if (p.re.test(text) || p.re.test(norm)) {
        return { violation: true, category: p.category, severity: p.severity, reason: p.reason, source: 'rules' };
      }
    }
    // Spam-pinging is classic griefing on Discord.
    if (mentionCount >= 6) {
      return { violation: true, category: 'griefing', severity: 'medium', reason: 'Mass-mention spam', source: 'rules' };
    }
    return { violation: false, source: 'rules' };
  };
}
