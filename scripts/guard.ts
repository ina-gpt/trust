/**
 * guard — the disclosure guard (R6), public-safe by construction.
 *
 * THE PROBLEM WITH THE OBVIOUS IMPLEMENTATION
 *   A denylist of terms that must never appear in public is itself a document
 *   that must never appear in public. Committing "do not mention X, Y, Z" to a
 *   public repository publishes X, Y and Z, in a file conveniently titled so
 *   that anyone can find it. The obvious implementation defeats its own purpose.
 *
 * WHAT THIS DOES INSTEAD
 *   The plaintext list lives only in a private repository. This public repo
 *   carries guard/forbidden.hmac: HMAC-SHA256 digests keyed with
 *   DISCLOSURE_GUARD_KEY. Without the key the digests are not a wordlist — a
 *   plain SHA-256 of a short term would be trivially reversed by a dictionary,
 *   which is exactly why this is keyed and not hashed.
 *
 *   Scanning normalises the text, emits every 1..4-token sliding window, HMACs
 *   each window with the same key, and compares. A hit reports the file, the
 *   line and the window LENGTH — and the token only as a mask (first character
 *   plus length), so a CI log that anybody can read never carries the term the
 *   guard exists to keep unpublished.
 *
 * FAIL CLOSED
 *   No key, or no digest file, is exit 2 — never a skip. A guard that silently
 *   passes when it cannot run converts an absent secret into a green tick,
 *   which is the failure mode that makes every other gate in this repository
 *   worthless.
 *
 * Exit 0 clean · 1 a forbidden term is present · 2 the guard could not run.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { REPO } from './lib.ts';
import { normalize, hmacToken, MAX_WINDOW_TOKENS } from './guard-core.ts';

/**
 * The digest set. Overridable with --hmac= so the negative proof can point the
 * guard at a throwaway set built from a synthetic canary term — which is how
 * the guard gets proven without committing a forbidden term to a public repo.
 */
const hmacArg = process.argv.slice(2).find((a) => a.startsWith('--hmac='));
const HMAC_PATH = hmacArg ? resolve(hmacArg.slice('--hmac='.length)) : resolve(REPO, 'guard/forbidden.hmac');
const MAX_WINDOW = MAX_WINDOW_TOKENS;

/**
 * R6's only exception: attribution files. Apache-2.0 §4 makes upstream
 * attribution a legal obligation, so a licence notice may name what it must.
 * An exact-path allow-list, never a pattern — a pattern would let
 * `docs/LICENSE-marketing-copy.md` exempt itself.
 */
const EXEMPT_PATHS = new Set([
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
  'THIRD_PARTY_NOTICES.md',
  'THIRD-PARTY-NOTICES.md',
  'NOTICE',
  // This file explains the guard; it contains no term, but it must never be
  // scanned into a false positive by a future edit that quotes one.
  'scripts/guard.ts',
]);

function die(msg: string): never {
  process.stderr.write(`guard: FATAL ${msg}\n`);
  process.exit(2);
}

const KEY = process.env.DISCLOSURE_GUARD_KEY;
if (!KEY || KEY.length < 16) {
  die(
    'DISCLOSURE_GUARD_KEY is not set (or is too short).\n' +
      '       The guard REFUSES to run rather than skip: an absent secret must not\n' +
      '       become a passing build. Set the organisation secret, or export the key\n' +
      '       locally from the private policy store.'
  );
}

if (!existsSync(HMAC_PATH)) {
  die(`guard/forbidden.hmac not found at ${HMAC_PATH} — regenerate it with scripts/build-denylist.ts`);
}

interface DigestFile {
  algorithm: string;
  max_window_tokens: number;
  count: number;
  digests: string[];
}

let digestFile: DigestFile;
try {
  digestFile = JSON.parse(readFileSync(HMAC_PATH, 'utf8')) as DigestFile;
} catch (e) {
  die(`guard/forbidden.hmac is unreadable: ${(e as Error).message}`);
}
if (!Array.isArray(digestFile.digests) || digestFile.digests.length === 0) {
  die('guard/forbidden.hmac contains no digests — refusing to scan with an empty rule set');
}
const DIGESTS = new Set(digestFile.digests);

/** Mask a matched window so the log never carries the term. */
function mask(window: string): string {
  const first = window.slice(0, 1);
  return `${first}${'*'.repeat(Math.max(0, window.length - 1))} (${window.length} chars)`;
}

interface Finding { path: string; line: number; masked: string; tokens: number }

function scanText(path: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split('\n');
  lines.forEach((raw, idx) => {
    const norm = normalize(raw);
    if (!norm) return;
    const tokens = norm.split(' ');
    for (let n = 1; n <= Math.min(MAX_WINDOW, tokens.length); n++) {
      for (let i = 0; i + n <= tokens.length; i++) {
        const window = tokens.slice(i, i + n).join(' ');
        if (DIGESTS.has(hmacToken(window, KEY!))) {
          findings.push({ path, line: idx + 1, masked: mask(window), tokens: n });
        }
      }
    }
  });
  return findings;
}

/* --------------------------------------------------------------- targets -- */
const targets: string[] = [];
const argTargets = process.argv.slice(2).filter((a) => !a.startsWith('--'));

function collect(dirOrFile: string) {
  const abs = resolve(REPO, dirOrFile);
  if (!existsSync(abs)) return;
  if (statSync(abs).isFile()) { targets.push(abs); return; }
  for (const name of readdirSync(abs)) {
    const child = join(abs, name);
    if (statSync(child).isDirectory()) { collect(relative(REPO, child)); continue; }
    if (!/\.(md|json|txt|ya?ml|html)$/i.test(name)) continue;
    targets.push(child);
  }
}

if (argTargets.length > 0) {
  for (const t of argTargets) collect(t);
} else {
  // Default scope: every generated surface, every template, and the register.
  for (const d of ['build', 'templates', 'data', 'logos']) collect(d);
}

if (targets.length === 0) {
  die('no files to scan — a guard that read nothing is not a pass');
}

const findings: Finding[] = [];
let scanned = 0;
for (const abs of targets) {
  const rel = relative(REPO, abs);
  if (EXEMPT_PATHS.has(rel)) continue;
  scanned++;
  findings.push(...scanText(rel, readFileSync(abs, 'utf8')));
}

if (scanned === 0) die('every candidate file was exempt — refusing to report clean');

if (findings.length > 0) {
  for (const f of findings) {
    process.stdout.write(`${f.path}:${f.line}: [R6] forbidden disclosure — ${f.tokens}-token match ${f.masked}\n`);
  }
  process.stdout.write(
    `\nguard: FAIL — ${findings.length} forbidden disclosure(s) across ${scanned} file(s).\n` +
      '       The matched term is masked on purpose: this log is public.\n' +
      '       Consult the private denylist to see which term matched.\n'
  );
  process.exit(1);
}

process.stdout.write(`guard: OK — ${scanned} file(s) scanned against ${DIGESTS.size} digest(s), windows 1..${MAX_WINDOW}\n`);
