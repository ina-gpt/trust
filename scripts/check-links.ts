/**
 * check-links — every primary-source link must actually answer.
 *
 * A trust register whose "verify" links 404 is worse than one with no links: it
 * invites a reader to check, and then tells them the claim cannot be checked.
 * This runs monthly on a schedule for exactly that reason — link rot is silent
 * and nobody notices it from the inside.
 *
 * HEAD first, GET on fallback: several public registries answer 405 to HEAD.
 * A 405 is not a dead link, so treating it as one would produce a permanently
 * red gate that gets disabled — the same failure as no gate.
 *
 * Exit 0 all live · 1 at least one dead · 2 could not run.
 */
import { loadRegister, todayUTC, daysBetween, type Register } from './lib.ts';

const TIMEOUT_MS = 10_000;
const RETRIES = 2;
const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

/**
 * THREE OUTCOMES, NOT TWO.
 *
 *   LIVE     2xx/3xx — the reader can reach it.
 *   BLOCKED  the server refuses automated requests (403/429 even with a browser
 *            user-agent, from a datacenter address). That is a fact about the
 *            CHECKER, not about the link, and calling it dead would make this
 *            gate permanently red — after which it gets switched off, which is
 *            the same as having no gate. Reported and counted, never silently
 *            passed, never fatal.
 *   DEAD     404/410/4xx-other/5xx/network — the link is actually broken.
 *            Fatal, because an evidence URL that does not resolve defeats the
 *            only purpose the register has.
 *
 * This is the same distinction the estate insists on everywhere else: "we could
 * not check" and "it is fine" are different answers, and so are "we could not
 * check" and "it is broken".
 */
type Verdict = 'LIVE' | 'BLOCKED' | 'DEAD';

interface Result { label: string; url: string; status: number | string; verdict: Verdict; method: string }

async function attempt(url: string, method: 'HEAD' | 'GET'): Promise<{ status: number | string; ok: boolean }> {
  try {
    const resp = await fetch(url, {
      method,
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': BROWSER_UA, Accept: '*/*' },
    });
    return { status: resp.status, ok: resp.status >= 200 && resp.status < 400 };
  } catch (e) {
    return { status: (e as Error).name || 'network-error', ok: false };
  }
}

async function probe(url: string): Promise<{ status: number | string; verdict: Verdict; method: string }> {
  let last: { status: number | string; ok: boolean } = { status: 'unreachable', ok: false };
  let method: 'HEAD' | 'GET' = 'HEAD';

  for (let round = 0; round <= RETRIES; round++) {
    if (round > 0) await new Promise((res) => setTimeout(res, 500 * 2 ** (round - 1)));

    last = await attempt(url, 'HEAD');
    method = 'HEAD';
    if (last.ok) return { status: last.status, verdict: 'LIVE', method };

    // Plenty of registries answer HEAD with 405/501 — and some with 403 or 404
    // — while serving the page perfectly to a GET. Escalate before judging.
    last = await attempt(url, 'GET');
    method = 'GET';
    if (last.ok) return { status: last.status, verdict: 'LIVE', method };
  }

  const blocked = last.status === 403 || last.status === 429 || last.status === 999;
  return { status: last.status, verdict: blocked ? 'BLOCKED' : 'DEAD', method };
}

const r: Register = loadRegister();

const targets: Array<{ label: string; url: string }> = [];
for (const e of r.certifications) if (e.evidence_url) targets.push({ label: `certifications/${e.id}`, url: e.evidence_url });
for (const e of r.memberships) if (e.evidence_url) targets.push({ label: `memberships/${e.id}`, url: e.evidence_url });
for (const e of r.registrations) targets.push({ label: `registrations/${e.id}`, url: e.evidence_url });

if (targets.length === 0) {
  process.stderr.write('check-links: FATAL no evidence URLs found — refusing to report clean\n');
  process.exit(2);
}

const results: Result[] = [];
for (const t of targets) {
  const p = await probe(t.url);
  results.push({ ...t, ...p });
  const tag = p.verdict === 'LIVE' ? 'ok     ' : p.verdict === 'BLOCKED' ? 'BLOCKED' : 'DEAD   ';
  process.stdout.write(`${tag} ${t.label.padEnd(28)} ${String(p.status).padEnd(10)} ${p.method}  ${t.url}\n`);
}

/* Renewal horizon — reported here too, so the monthly run is the one place an
 * operator has to look for both kinds of decay. */
const today = todayUTC();
const renewals: string[] = [];
for (const e of r.certifications) {
  if (!e.valid_to) continue;
  const remaining = daysBetween(today, e.valid_to);
  for (const horizon of [30, 90, 180]) {
    if (remaining <= horizon && remaining >= 0) {
      renewals.push(`${e.id} expires in ${remaining} day(s) on ${e.valid_to} (inside the ${horizon}-day horizon)`);
      break;
    }
  }
}
for (const n of renewals) process.stdout.write(`RENEWAL  ${n}\n`);

const dead = results.filter((x) => x.verdict === 'DEAD');
const blocked = results.filter((x) => x.verdict === 'BLOCKED');

if (blocked.length > 0) {
  process.stdout.write(
    `\nnote  ${blocked.length} link(s) refuse automated checks from this address (403/429).\n` +
      '      They are NOT reported as broken: that would be a claim about the link\n' +
      '      rather than about the checker. Verify them from a browser once per\n' +
      '      renewal cycle; they are listed above with their status.\n'
  );
}

process.stdout.write(
  `\ncheck-links: ${dead.length === 0 ? 'OK' : 'FAIL'} — ${results.length} probed · ` +
    `${results.length - dead.length - blocked.length} live · ${blocked.length} blocked · ${dead.length} dead · ` +
    `${renewals.length} renewal notice(s)\n`
);
process.exit(dead.length > 0 ? 1 : 0);
