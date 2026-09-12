/**
 * guard-core — the pure half of the disclosure guard.
 *
 * Split out so build-denylist.ts can normalise and HMAC terms without importing
 * guard.ts, which has top-level side effects by design (it refuses to load
 * without a key). More importantly, the compiler now enforces that the
 * generator and the scanner normalise text THE SAME WAY: if they diverged, a
 * term would be hashed in one form and searched for in another, and the guard
 * would report clean forever while protecting nothing.
 */
import { createHmac } from 'node:crypto';

/**
 * Normalise text for matching.
 *
 * Lower-case, NFKC-fold, strip punctuation that is not part of an identifier,
 * collapse whitespace. `.`, `:`, `@`, `/` and `-` survive because they are
 * load-bearing inside the things this guard looks for — product tags, package
 * names, hostnames — and stripping them would split one term into several that
 * no longer match.
 */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s.:@/-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function hmacToken(token: string, key: string): string {
  return createHmac('sha256', key).update(token, 'utf8').digest('hex');
}

export const MAX_WINDOW_TOKENS = 4;
