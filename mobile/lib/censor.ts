/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Profanity / slur censor.
 *
 *   import { censorText } from '../lib/censor';
 *
 *   const safe = censorText(rawBody, user?.censor_offensive_language ?? true);
 *
 * When the user's `censor_offensive_language` flag is true (the default),
 * every word in `BAD_WORDS` is replaced with an asterisk-mask the same
 * length as the original word so the surrounding sentence still reads.
 * When the flag is false the input passes through untouched.
 *
 * Matching rules:
 *   • Case-insensitive.
 *   • Word-boundary anchored by default, so "scunthorpe"-style false
 *     positives don't fire — e.g. "class" doesn't trigger because we
 *     match `\bass\b`, not `ass` anywhere in the string.
 *   • A small set of EXTRA-bad slurs (BAD_WORDS_NO_BOUNDARY) match even
 *     mid-word so users can't trivially hide them with surrounding chars.
 *   • Common leetspeak swaps (`@` for `a`, `0` for `o`, `1` for `i`,
 *     `3` for `e`, `$` for `s`) are normalised before matching so the
 *     filter catches `f@ck` / `sh1t` / etc.
 *
 * Word list policy:
 *   • Curse words: the common American-English set.
 *   • Slurs: the standard set of racial / homophobic / ableist slurs
 *     that App Review enforces against. Keeping these in source is
 *     intentional and unavoidable — they need to be matchable to be
 *     censored. Reviewers and any reader: this list exists so users
 *     never see these in the app.
 *
 * Performance: ~80 words, one combined regex compiled lazily at first
 * call. O(n) in input length per call; cheap enough to run on every
 * chat / post / DM render.
 */

// Curse words — word-boundary anchored to avoid false positives.
const BAD_WORDS: string[] = [
  // f-word + derivatives
  'fuck', 'fucker', 'fucking', 'fucked', 'fuckin', 'motherfucker', 'motherfucking',
  'fck', 'fuk',
  // s-word + derivatives
  'shit', 'shitter', 'shitty', 'shitting', 'bullshit', 'horseshit',
  // various
  'bitch', 'bitches', 'bitchy', 'bastard', 'asshole', 'assholes', 'jackass',
  'damn', 'damnit', 'goddamn', 'goddamnit',
  'crap', 'crappy', 'piss', 'pissed', 'pissing',
  'dick', 'dickhead', 'dickface', 'cock', 'cocks',
  'pussy', 'twat', 'cunt', 'cunts',
  'whore', 'whores', 'slut', 'sluts',
  'prick', 'wanker', 'tosser',
  // partial / less severe
  'ass', 'arse', 'arsehole',
  'douche', 'douchebag',
];

// Slurs — matched WITHOUT word boundaries so a deliberately spaced or
// punctuated variant ("n!gger") still gets caught after leetspeak normalize.
// This list is intentionally explicit; censorship requires matchability.
const BAD_WORDS_NO_BOUNDARY: string[] = [
  // racial
  'nigger', 'nigga', 'niggas', 'niggers', 'chink', 'gook', 'spic', 'kike', 'wetback',
  // homophobic
  'faggot', 'faggots', 'fag', 'fags', 'dyke', 'tranny', 'trannies',
  // ableist
  'retard', 'retarded', 'retards',
];

/** Replace each character with `*`, length-matched. */
function maskWord(w: string): string {
  return '*'.repeat(w.length);
}

/** Normalise common leetspeak / character substitutions BEFORE matching.
 *  Returned string is the same length as the input, so masking positions
 *  still line up with the original characters.
 *
 *  Important: this normalises a COPY used only for detection. The visible
 *  output keeps the user's original characters where they aren't censored. */
function normalizeForMatch(s: string): string {
  return s
    .replace(/@/g, 'a')
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/\$/g, 's')
    .replace(/!/g, 'i');
}

// Lazy-compiled regex pair so first call pays the cost but every render
// after that hits the compiled instance.
let _wordBoundaryRe: RegExp | null = null;
let _anywhereRe: RegExp | null = null;
function getRegexes(): { wb: RegExp; anywhere: RegExp } {
  if (!_wordBoundaryRe || !_anywhereRe) {
    const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    _wordBoundaryRe = new RegExp(`\\b(${BAD_WORDS.map(esc).join('|')})\\b`, 'gi');
    _anywhereRe = new RegExp(`(${BAD_WORDS_NO_BOUNDARY.map(esc).join('|')})`, 'gi');
  }
  return { wb: _wordBoundaryRe, anywhere: _anywhereRe };
}

/**
 * Censor offensive language in `text`. Returns the input unchanged when
 * `enabled` is false. Otherwise: case-insensitively replaces each bad
 * word with an asterisk mask of the same length.
 *
 *   censorText("what the fuck", true)        → "what the ****"
 *   censorText("c@ll me a b!tch", true)      → "c@ll me a *****"   // matches via normalize
 *   censorText("classroom",        true)     → "classroom"          // \bass\b doesn't fire mid-word
 *   censorText("anything",         false)    → "anything"
 *
 * The function operates on the NORMALISED string for matching but writes
 * `*`s into the SAME INDEX positions of the ORIGINAL string so casing /
 * spacing / leet-substitutions in the surrounding text are preserved.
 */
export function censorText(text: string, enabled: boolean): string {
  if (!enabled) return text;
  if (!text) return text;

  const { wb, anywhere } = getRegexes();
  const norm = normalizeForMatch(text);

  // We collect every match's [start, end) interval, then walk the original
  // string applying the mask at those positions. Doing it in two passes
  // (rather than a chained `text.replace(...)`) is important because the
  // matches come from the NORMALISED string, but we need the mask written
  // into the ORIGINAL string at the same positions.
  const intervals: [number, number][] = [];
  let m: RegExpExecArray | null;

  wb.lastIndex = 0;
  while ((m = wb.exec(norm)) !== null) {
    intervals.push([m.index, m.index + m[0].length]);
    // Prevent zero-length runaway on degenerate matches.
    if (m.index === wb.lastIndex) wb.lastIndex++;
  }
  anywhere.lastIndex = 0;
  while ((m = anywhere.exec(norm)) !== null) {
    intervals.push([m.index, m.index + m[0].length]);
    if (m.index === anywhere.lastIndex) anywhere.lastIndex++;
  }

  if (intervals.length === 0) return text;

  // Merge overlapping intervals so a slur that contains a curse word
  // doesn't get masked twice (would be visually identical, but cleaner).
  intervals.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [intervals[0]];
  for (let i = 1; i < intervals.length; i++) {
    const last = merged[merged.length - 1];
    if (intervals[i][0] <= last[1]) {
      last[1] = Math.max(last[1], intervals[i][1]);
    } else {
      merged.push(intervals[i]);
    }
  }

  // Build the output by walking the original string and overwriting
  // each merged interval with a length-matched mask.
  let out = '';
  let cursor = 0;
  for (const [start, end] of merged) {
    out += text.slice(cursor, start);
    out += maskWord(text.slice(start, end));
    cursor = end;
  }
  out += text.slice(cursor);
  return out;
}

/**
 * Hook that returns a memoised censor function bound to the current user's
 * `censor_offensive_language` preference.
 *
 *   const c = useCensor();
 *   <Text>{c(player.username)}</Text>
 *
 * Default ON: when the user record isn't loaded yet (anon screens, first
 * paint before /users/me resolves) the censor fires anyway. That's the
 * App-Review-safe default — content can only become MORE permissive after
 * the auth callback returns the user's explicit `false`.
 *
 * The returned function:
 *   • Accepts string, null, or undefined; the latter two pass through as
 *     the empty string so callers can use it on optional fields without
 *     `?? ''` boilerplate.
 *   • Is referentially stable while the user's preference doesn't change,
 *     so passing it as a render-time helper doesn't cause cascading
 *     re-renders.
 *
 * Defined here rather than in a separate hooks file so the censor utility
 * has zero React-tree dependencies for non-component callers (server-side
 * formatters, tests) while still being one-stop for components.
 */
import { useCallback } from 'react';
import { useAuth } from './auth';

export function useCensor(): (s: string | null | undefined) => string {
  const { user } = useAuth();
  const enabled = (user as any)?.censor_offensive_language !== false;
  return useCallback(
    (s) => censorText(s ?? '', enabled),
    [enabled],
  );
}
