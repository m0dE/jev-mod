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
  { category: 'rudeness', severity: 'low', reason: 'Hostile language',
    re: /\b(?:shut\s+(?:the\s+f\w*\s+)?up|stfu|f+u+c+k+\s+(?:you|u|off)|screw\s+you|nobody\s+(?:asked|likes\s+you))\b/i },

  // griefing: organising or bragging about ruining others' play, raids
  { category: 'griefing', severity: 'medium', reason: 'Griefing / raiding',
    re: /\b(?:let'?s|lets|gonna|going\s+to|i\s+just)\s+(?:grief|raid|wreck|destroy|burn\s+down|nuke)\b|\bgrief(?:ed|ing)?\s+(?:their|his|her|ur|your|the)\b|\braid\s+(?:this|the)\s+server\b/i },

  // negativity aimed at the community
  { category: 'negativity', severity: 'low', reason: 'Trashing the server or community',
    re: /\b(?:this|the)\s+(?:server|community|game|mods?|staff|admins?)\s+(?:is|are)\s+(?:trash|garbage|dead|shit|terrible|a\s+joke|cancer)\b|\beveryone\s+here\s+(?:is|are)\s+(?:trash|stupid|idiots|losers)\b/i },
];

// Scams: fake gifts and giveaways, phishing links. Hacked accounts post these constantly.
const URL_RE = /\b(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:\/\S*)?/gi;
const REAL_DOMAINS = /(?:^|\.)(?:discord\.com|discord\.gg|discordapp\.com|discordapp\.net|discord\.gift|discord\.media|steampowered\.com|steamcommunity\.com|steamstatic\.com|s\.team)$/i;
// Hostnames dressed up as Discord or Steam: dlscord-nitro.com, discorcl.gift, steamcommunlty.ru …
const LOOKALIKE = /d[i1l!|]s[ck]{1,2}[o0]?r[dcl]|st[e3][a4@]m|nitro/i;

const SCAM_PATTERNS = [
  /(?:\bfree\s+(?:discord\s+)?nitro\b|\bnitro\s+(?:for\s+)?free\b).*(?:https?:\/\/|\.\w{2,}\/|dm\s+me|claim)/i,
  /\b(?:steam|discord|nitro)\s+(?:gift|giveaway|airdrop)\b.*(?:https?:\/\/|\.\w{2,}\/)/i,
  /\b(?:airdrop|giveaway|free\s+(?:crypto|btc|eth|sol|usdt|robux|skins?))\b.*(?:https?:\/\/|\.\w{2,}\/|dm\s+me|claim)/i,
  /\b(?:claim|redeem)\s+(?:your|ur|the)\s+(?:gift|reward|prize|nitro|free)\b/i,
  // "I accidentally reported your account, contact this 'staff member'…"
  /\b(?:accidentally|mistakenly)\s+report(?:ed)?\s+(?:you|ur|your)\b|\breported\s+(?:you|your\s+account)\s+by\s+(?:accident|mistake)\b/i,
  /\bi(?:'m| am)\s+(?:giving\s+away|leaving\s+(?:cs|steam|the\s+game)).*(?:skins?|items?|inventory)\b/i,
];

/** Fake Discord/Steam links, scam phrases, or @everyone with a link. */
export function looksLikeScam(text) {
  const hosts = [...text.matchAll(URL_RE)].map((m) => m[1].toLowerCase());
  if (hosts.some((h) => LOOKALIKE.test(h) && !REAL_DOMAINS.test(h))) return 'Fake Discord or Steam link';
  // "Beware, there's a free nitro scam going around" is a warning, not a scam.
  if (!/\bscam/i.test(text) && SCAM_PATTERNS.some((re) => re.test(text))) return 'Scam message';
  if (/@(?:everyone|here)\b/.test(text) && /https?:\/\//i.test(text)) return 'Mass-ping with a link';
  return null;
}

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

    const scam = looksLikeScam(text);
    if (scam) {
      return { violation: true, category: 'scam', severity: 'high', reason: scam, source: 'rules', standalone: true };
    }
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
      // Disruptive on its own, so it doesn't need a pattern like other griefing.
      return { violation: true, category: 'griefing', severity: 'medium', reason: 'Mass-mention spam', source: 'rules', standalone: true };
    }
    return { violation: false, source: 'rules' };
  };
}
