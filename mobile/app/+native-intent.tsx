/**
 * Deep-link normalizer. Runs on every inbound system URL BEFORE Expo Router
 * matches it to a route, so a malformed link never lands on "unmatched route".
 *
 * The one external deep link we ship is the creator-league QR (`sacari:///join/
 * <CODE>`). Custom-scheme URLs parse inconsistently across iOS/Android and Expo
 * Router versions: the code can arrive as `/join/<CODE>`, `join/<CODE>`, or with
 * a stray host segment. Whenever we can spot a `join/<CODE>` anywhere in the
 * path, we force it to the canonical `/join/<CODE>`. Everything else passes
 * through untouched (internal navigation never reaches this).
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    const m = /(?:^|\/)join\/([A-Za-z0-9_-]+)/i.exec(path);
    if (m) return `/join/${m[1]}`;
  } catch {
    // fall through to the original path on any parse hiccup
  }
  return path;
}
