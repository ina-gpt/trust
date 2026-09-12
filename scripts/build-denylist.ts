/**
 * build-denylist — regenerate guard/forbidden.hmac from the PRIVATE plaintext list.
 *
 * The plaintext never enters this repository. This script reads it from a path
 * outside the repo (or from --in=), normalises each term exactly as guard.ts
 * normalises scanned text, HMACs it, and writes only digests.
 *
 * Run it whenever the private list changes:
 *   DISCLOSURE_GUARD_KEY=… npx tsx scripts/build-denylist.ts --in=/path/to/denylist.txt
 *
 * Determinism: digests are sorted, so an unchanged input produces a
 * byte-identical file and the drift check stays meaningful.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO } from './lib.ts';
import { normalize, hmacToken } from './guard-core.ts';

const args = process.argv.slice(2);
const inArg = args.find((a) => a.startsWith('--in='));
const OUT = resolve(REPO, 'guard/forbidden.hmac');
const MAX_WINDOW = 4;

const KEY = process.env.DISCLOSURE_GUARD_KEY;
if (!KEY || KEY.length < 16) {
  process.stderr.write('build-denylist: FATAL DISCLOSURE_GUARD_KEY is not set (or too short)\n');
  process.exit(2);
}

const IN = inArg ? resolve(inArg.slice('--in='.length)) : '';
if (!IN || !existsSync(IN)) {
  process.stderr.write(
    'build-denylist: FATAL pass --in=<path to the PRIVATE plaintext denylist>.\n' +
      '                The plaintext must never live in this repository.\n'
  );
  process.exit(2);
}

const terms = readFileSync(IN, 'utf8')
  .split('\n')
  .map((l) => l.replace(/#.*$/, ''))
  .map((l) => normalize(l))
  .filter(Boolean);

if (terms.length === 0) {
  process.stderr.write('build-denylist: FATAL the denylist parsed to zero terms — refusing to write an empty rule set\n');
  process.exit(2);
}

const tooLong = terms.filter((t) => t.split(' ').length > MAX_WINDOW);
if (tooLong.length > 0) {
  process.stderr.write(
    `build-denylist: FATAL ${tooLong.length} term(s) exceed ${MAX_WINDOW} tokens and could never match.\n` +
      '                A term the scanner cannot reach is a silent hole; shorten it or raise MAX_WINDOW in both files.\n'
  );
  process.exit(2);
}

const digests = [...new Set(terms.map((t) => hmacToken(t, KEY)))].sort();

const payload = {
  algorithm: 'hmac-sha256(normalized_term, DISCLOSURE_GUARD_KEY)',
  note:
    'Digests only. The plaintext list lives in the private policy repository. ' +
    'Keyed rather than plain-hashed: a plain SHA-256 of a short product name is ' +
    'recoverable with a dictionary, which would defeat the purpose of not ' +
    'publishing the list.',
  max_window_tokens: MAX_WINDOW,
  count: digests.length,
  digests,
};

writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
process.stdout.write(`build-denylist: wrote ${digests.length} digest(s) to guard/forbidden.hmac (from ${terms.length} term(s))\n`);
