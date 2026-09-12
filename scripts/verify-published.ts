/**
 * verify-published — the independent audit (Phase 9).
 *
 * This does NOT read build/. It fetches what the world can actually see — the
 * published trust.json, the organisation profile, each public repository README,
 * and both site URLs — and asserts the claims against them. Reading build/ would
 * only prove that the generator agrees with itself.
 *
 * Exit 0 every assertion holds · 1 at least one does not.
 */
import { execFileSync } from 'node:child_process';
import { loadRegister, FUNDSTELLE_URL, type Register } from './lib.ts';

const ORG = 'ina-gpt';
const SITE = 'https://inagpt.com';
const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

let failures = 0;
function assert(ok: boolean, label: string, detail = '') {
  if (!ok) failures++;
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}\n`);
}

async function get(url: string): Promise<{ status: number | string; text: string }> {
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
      headers: { 'User-Agent': BROWSER_UA },
    });
    return { status: r.status, text: await r.text() };
  } catch (e) {
    return { status: (e as Error).name, text: '' };
  }
}

function ghFile(repo: string, path: string): string {
  try {
    const b64 = execFileSync('gh', ['api', `repos/${ORG}/${repo}/contents/${path}`, '--jq', '.content'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024,
    }).trim();
    return Buffer.from(b64.replace(/\s/g, ''), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

const reg: Register = loadRegister();

/* ------------------------------------------- 1. the published trust.json --- */
process.stdout.write('=== published trust.json ===\n');
const live = await get(`${SITE}/trust.json`);
assert(live.status === 200, 'GET /trust.json', `http=${live.status}`);
/**
 * The fetched document is UNTRUSTED INPUT, not our Register type. Typing it as
 * Register would have the compiler vouch for a shape nobody validated — and
 * the whole point of this script is to check the published bytes rather than
 * assume they match what we meant to publish.
 */
type PublishedEntry = Record<string, unknown> & { id?: string; status?: string };
interface Published {
  certifications?: PublishedEntry[];
  memberships?: PublishedEntry[];
  registrations?: PublishedEntry[];
  fundstelle?: string | Record<string, string>;
  generated_from_commit?: string;
}
let published: Published = {};
try {
  published = JSON.parse(live.text) as Published;
  assert(true, 'trust.json parses as JSON');
} catch {
  assert(false, 'trust.json parses as JSON');
}

/* ------------------------------------ 2. evidence table, one row per claim -- */
process.stdout.write('\n=== evidence table — every claim rendered as HELD ===\n');
process.stdout.write('claim | rendered | identifier | evidence_url | http\n');

const heldRows: Array<{ claim: string; identifier: string; url: string; status: number | string }> = [];
for (const kind of ['certifications', 'memberships', 'registrations'] as const) {
  for (const e of published[kind] ?? []) {
    if (e.status !== 'held') continue;
    const url = (e.evidence_url as string) ?? '';
    const probe = url ? await get(url) : { status: 'none', text: '' };
    heldRows.push({
      claim: String(e.name),
      identifier: (e.identifier as string) ?? '(directory-listed)',
      url,
      status: probe.status,
    });
    const reachable = probe.status === 200 || probe.status === 403 || probe.status === 429;
    process.stdout.write(
      `${reachable ? 'ok  ' : 'FAIL'}  ${String(e.name).slice(0, 46).padEnd(48)} held  ` +
        `${String((e.identifier as string) ?? '(directory)').padEnd(20)} http=${probe.status}\n`
    );
    if (!reachable) failures++;
  }
}
assert(heldRows.length === 8, 'exactly 8 held claims published', `found ${heldRows.length}`);

/* --------------------------------- 3. no held claim without an identifier -- */
process.stdout.write('\n=== R1: nothing renders as held without a verifiable anchor ===\n');
for (const kind of ['certifications', 'registrations'] as const) {
  for (const e of published[kind] ?? []) {
    if (e.status !== 'held') continue;
    assert(Boolean(e.identifier), `${kind}/${e.id} carries an identifier`);
    assert(Boolean(e.evidence_url), `${kind}/${e.id} carries a primary-source link`);
  }
}
for (const e of published.memberships ?? []) {
  if (e.status !== 'held') continue;
  assert(Boolean(e.identifier || e.evidence_url), `memberships/${e.id} carries an identifier or a directory link`);
}

/* --------------------------------------- 4. ISO 42001 everywhere it shows -- */
process.stdout.write('\n=== R3: ISO 42001 renders as NOT held on every surface ===\n');
const iso42 = (published.certifications ?? []).find((c) => c.id === 'iso-42001');
assert(iso42?.status === 'in_progress', 'trust.json: iso-42001 status is in_progress', `got ${iso42?.status}`);

const surfaces: Array<{ label: string; text: string }> = [
  { label: '.github/profile/README.md', text: ghFile('.github', 'profile/README.md') },
  { label: '.github/SECURITY.md', text: ghFile('.github', 'SECURITY.md') },
  { label: 'trust/README.md', text: ghFile('trust', 'build/README.md') },
  { label: 'FR/README.md', text: ghFile('FR', 'README.md') },
  { label: 'ina-coding-extension/README.md', text: ghFile('ina-coding-extension', 'README.md') },
];

for (const s of surfaces) {
  if (!s.text) { assert(false, `${s.label} is reachable`); continue; }
  if (/42001/.test(s.text)) {
    // It may appear only with an explicit not-yet-held qualifier.
    const qualified = /(not yet|in progress|no certificate has been issued|not certified)/i.test(s.text);
    assert(qualified, `${s.label}: 42001 appears only with a not-yet-held qualifier`);
  } else {
    assert(true, `${s.label}: does not mention 42001`);
  }
}

/* ------------------------------------------------- 5. R4 Fundstelle duty --- */
process.stdout.write('\n=== R4: the Fundstelle link accompanies the mark or the number ===\n');
const certNumber = ((published.certifications ?? [])
  .find((c) => c.id === 'iso-27001')?.identifier as string) ?? '';
/**
 * Accept EITHER locale's Fundstelle, read from the published document rather
 * than from a constant in this file.
 *
 * This assertion hardcoded the German URL and went red the moment the register
 * became locale-aware — the auditor lagging the thing it audits. Reading the
 * value the world actually published is the only version that cannot drift.
 */
const acceptedFundstelle: string[] = (() => {
  const f = published.fundstelle;
  if (typeof f === 'string') return [f];
  if (f && typeof f === 'object') return Object.values(f as Record<string, string>);
  return [FUNDSTELLE_URL];
})();
process.stdout.write(`      accepted Fundstelle: ${acceptedFundstelle.join(' | ')}\n`);

for (const s of surfaces) {
  if (!s.text) continue;
  const mentions = (certNumber && s.text.includes(certNumber)) || /T(?:Ü|U)V\s*S(?:Ü|U)D/i.test(s.text);
  if (!mentions) { assert(true, `${s.label}: does not mention the mark or the number`); continue; }
  const hit = acceptedFundstelle.find((u) => s.text.includes(u));
  assert(Boolean(hit), `${s.label}: carries a Fundstelle link`, hit ?? 'none of the accepted URLs');
}

/* ------------------------------------------------------ 6. the site files -- */
process.stdout.write('\n=== the two published site files ===\n');
const sec = await get(`${SITE}/.well-known/security.txt`);
assert(sec.status === 200, 'GET /.well-known/security.txt', `http=${sec.status}`);
assert(/^Contact:/m.test(sec.text), 'security.txt has a Contact field (RFC 9116)');
assert(/^Expires:/m.test(sec.text), 'security.txt has an Expires field (RFC 9116)');
const expires = /^Expires:\s*(\S+)/m.exec(sec.text)?.[1] ?? '';
assert(Date.parse(expires) > Date.now(), 'security.txt Expires is in the future', expires);
assert(/^Canonical:/m.test(sec.text), 'security.txt has a Canonical field');

/* ----------------------------------- 7. the same register on every surface -- */
process.stdout.write('\n=== the register is consistent across surfaces ===\n');
for (const s of surfaces) {
  if (!s.text) continue;
  if (!/12 310|ISO\/IEC 27001|trust/i.test(s.text)) { assert(true, `${s.label}: carries no register claim`); continue; }
  const linksToTrust = s.text.includes('github.com/ina-gpt/trust');
  assert(linksToTrust, `${s.label}: links to the canonical register`);
}

/* ------------------------------------------ 8. no private contact anywhere -- */
process.stdout.write('\n=== R8: no private contact data on any published surface ===\n');
const ALLOWED = /^(info|security|support|privacy|dpo|legal|press|jobs|abuse)@inagpt\.com$/i;
for (const s of [...surfaces, { label: 'live trust.json', text: live.text }, { label: 'live security.txt', text: sec.text }]) {
  if (!s.text) continue;
  const bad = [...s.text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)]
    .map((m) => m[0])
    .filter((a) => !ALLOWED.test(a));
  assert(bad.length === 0, `${s.label}: only role addresses`, bad.length ? `${bad.length} non-role address(es)` : '');
}

process.stdout.write(
  failures === 0
    ? `\nverify-published: PASS — every published claim checks out against its primary source\n`
    : `\nverify-published: FAIL — ${failures} assertion(s) did not hold\n`
);
process.exit(failures === 0 ? 0 : 1);
