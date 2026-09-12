/**
 * negative — the proof that the gates can fail.
 *
 * A gate that cannot fail proves nothing, so every rule in validate.ts and the
 * disclosure guard has a fixture here that MUST produce exit 1, and the test
 * asserts the specific rule id in the message. Asserting only the exit code
 * would pass if the register failed for an unrelated reason — which is how a
 * suite ends up green while the rule it claims to test has been deleted.
 *
 * The positive case is asserted too: the real register must pass. Without it
 * the suite would be satisfied by a validator that rejects everything.
 *
 * Exit 0 all fixtures behaved · 1 at least one did not.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync, writeFileSync, rmSync, mkdtempSync, copyFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { REPO, DATA_PATH } from './lib.ts';

const NEG_DIR = resolve(REPO, 'tests/negative');

interface Case { fixture: string; expectRule: string; description: string }

/** Fixture → the rule id its failure message must name. */
const CASES: Case[] = [
  { fixture: 'n01-held-without-identifier.yaml', expectRule: 'V2', description: 'held certification with no identifier' },
  { fixture: 'n02-held-without-evidence-url.yaml', expectRule: 'V2', description: 'held certification with no primary source' },
  { fixture: 'n03-iso42001-marked-held.yaml', expectRule: 'V3', description: 'ISO 42001 claimed as held' },
  { fixture: 'n04-expired-certificate.yaml', expectRule: 'V4', description: 'certificate whose validity has passed' },
  { fixture: 'n05-logo-without-permission.yaml', expectRule: 'V10', description: 'the superseded per-membership logo field is refused' },
  { fixture: 'n06-logo-sha256-mismatch.yaml', expectRule: 'V10', description: 'the superseded per-membership logo field is refused' },
  { fixture: 'n07-private-contact-leaked.yaml', expectRule: 'V7', description: 'private contact data in the register' },
  { fixture: 'n12-mark-credential-not-held.yaml', expectRule: 'V10', description: 'mark displaying a credential that is not held' },
  { fixture: 'n13-mark-sha256-mismatch.yaml', expectRule: 'V10', description: 'mark whose digest does not match the file' },
  { fixture: 'n14-mark-without-permission-evidence.yaml', expectRule: 'V10', description: 'mark with no permission evidence' },
  { fixture: 'n16-blocked-without-human-verify.yaml', expectRule: 'V11', description: 'blocked link with no human verification' },
  { fixture: 'n17-human-verify-expired.yaml', expectRule: 'V11', description: 'human verification 181 days old' },
  // Registered 2026-09-12 together with the fixtures themselves. make-fixtures
  // WRITES a fixture; this list is what RUNS it, and the two had to be edited
  // together — a fixture generated but absent here is a dead fixture, green by
  // never being executed.
  { fixture: 'n18-grantor-is-a-person.yaml', expectRule: 'V10', description: 'a natural person recorded as the grantor (R8)' },
  { fixture: 'n19-person-with-org-word.yaml', expectRule: 'V10', description: 'an org word appended to a personal name must not launder it' },
  { fixture: 'n20-document-ref-undated.yaml', expectRule: 'V12', description: 'document_on_request whose reference carries no date' },
  { fixture: 'n21-held-without-url-or-tier.yaml', expectRule: 'V12', description: 'held with neither a public URL nor a declared evidence tier' },
  { fixture: 'n22-public-registry-without-url.yaml', expectRule: 'V12', description: 'public_registry without the URL it promises' },
];

let failures = 0;
const matrix: string[] = [];

function record(id: string, ok: boolean, detail: string) {
  if (!ok) failures++;
  const line = `${ok ? 'ok  ' : 'FAIL'}  ${id.padEnd(34)} ${detail}`;
  matrix.push(line);
  process.stdout.write(`${line}\n`);
}

function runValidate(dataPath: string): { code: number; out: string } {
  const p = spawnSync('npx', ['tsx', 'scripts/validate.ts', `--data=${dataPath}`], {
    cwd: REPO, encoding: 'utf8', env: process.env,
  });
  return { code: p.status ?? -1, out: `${p.stdout ?? ''}${p.stderr ?? ''}` };
}

/* ------------------------------------------------------- data fixtures ---- */
process.stdout.write('=== validate rule fixtures (each MUST exit 1, naming its rule) ===\n');
for (const c of CASES) {
  const fx = join(NEG_DIR, c.fixture);
  if (!existsSync(fx)) { record(c.fixture, false, 'fixture file missing'); continue; }
  const { code, out } = runValidate(fx);
  const named = out.includes(c.expectRule);
  record(c.fixture, code === 1 && named,
    `exit=${code} (want 1) rule=${c.expectRule} ${named ? 'named' : 'NOT NAMED'} — ${c.description}`);
}

/* --------------------------------------------------------- V8 fixture ----- */
process.stdout.write('\n=== n08: certificate number without the Fundstelle link (V8) ===\n');
{
  const tmp = mkdtempSync(join(tmpdir(), 'ina-trust-n08-'));
  const buildDir = resolve(REPO, 'build');
  const stash = mkdtempSync(join(tmpdir(), 'ina-trust-stash-'));
  let restored = false;
  try {
    // Stash the real build/, plant a surface that names the certificate but
    // omits the Fundstelle link, and assert V8 catches it.
    for (const f of existsSync(buildDir) ? readdirSync(buildDir) : []) {
      copyFileSync(join(buildDir, f), join(stash, f));
    }
    mkdirSync(buildDir, { recursive: true });
    writeFileSync(join(buildDir, 'README.md'),
      '# Fixture\n\nCertified by TÜV SÜD, Reg. No. 12 310 71178 TMS.\nNo reference link here.\n', 'utf8');
    const { code, out } = runValidate(DATA_PATH);
    record('n08-certificate-without-fundstelle', code === 1 && out.includes('V8'),
      `exit=${code} (want 1) rule=V8 ${out.includes('V8') ? 'named' : 'NOT NAMED'}`);
  } finally {
    // Restore unconditionally. A fixture that leaves build/ sabotaged turns
    // every later run into a false red, and the cause is invisible.
    rmSync(buildDir, { recursive: true, force: true });
    mkdirSync(buildDir, { recursive: true });
    for (const f of readdirSync(stash)) copyFileSync(join(stash, f), join(buildDir, f));
    rmSync(stash, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
    restored = true;
  }
  if (!restored) record('n08-restore', false, 'build/ was not restored');
}

/* --------------------------------------------------------- guard fixture -- */
/**
 * n09 — the guard must fail on a forbidden term, mask it, and leak nothing.
 *
 * THE FIXTURE IS NOT COMMITTED, AND THAT IS THE POINT. The specification asked
 * for tests/negative/n09-forbidden-term-present.md containing a term whose HMAC
 * is in the digest set. In a PUBLIC repository that file would be a plaintext
 * disclosure of exactly what R6 forbids — the proof would commit the violation
 * it exists to catch.
 *
 * So the fixture is synthesised at run time, outside the repository, from a
 * SYNTHETIC canary term with its own throwaway digest set. That proves the
 * mechanism end to end — normalisation, windowing, HMAC comparison, masking,
 * non-leakage — while publishing nothing.
 *
 * n09b then proves the REAL digest set bites, using a real term read from the
 * private denylist when it is available locally. It is skipped-with-a-notice in
 * CI, where the plaintext list is deliberately absent; n09a still runs there,
 * so the mechanism is never unproven.
 */
process.stdout.write('\n=== n09a: the guard mechanism, proven on a synthetic canary (nothing published) ===\n');
{
  const { writeFileSync: w, mkdtempSync: mk, readFileSync: rd } = await import('node:fs');
  const { createHmac } = await import('node:crypto');
  const tmp = mk(join(tmpdir(), 'ina-trust-n09a-'));
  const key = process.env.DISCLOSURE_GUARD_KEY ?? '';
  const CANARY = 'zzq-canary-disclosure-token';
  try {
    const digest = createHmac('sha256', key).update(CANARY, 'utf8').digest('hex');
    const hmacPath = join(tmp, 'canary.hmac');
    w(hmacPath, JSON.stringify({ algorithm: 'hmac-sha256', max_window_tokens: 4, count: 1, digests: [digest] }, null, 2));
    const fixture = join(tmp, 'fixture.md');
    w(fixture, `# Fixture\n\nThis page mentions ${CANARY} which must never be published.\n`);
    const p = spawnSync('npx', ['tsx', 'scripts/guard.ts', `--hmac=${hmacPath}`, fixture], {
      cwd: REPO, encoding: 'utf8', env: process.env,
    });
    const out = `${p.stdout ?? ''}${p.stderr ?? ''}`;
    const failed = p.status === 1;
    const masked = /\*{2,}\s*\(\d+ chars\)/.test(out);
    const leaked = out.includes(CANARY);
    record('n09a-guard-mechanism', failed && masked && !leaked,
      `exit=${p.status} (want 1) masked=${masked} leaked_plaintext=${leaked}`);

    // ...and it must PASS on a clean file, or it is merely always-red.
    const clean = join(tmp, 'clean.md');
    w(clean, '# Fixture\n\nNothing forbidden here.\n');
    const q = spawnSync('npx', ['tsx', 'scripts/guard.ts', `--hmac=${hmacPath}`, clean], {
      cwd: REPO, encoding: 'utf8', env: process.env,
    });
    record('n09a-guard-not-always-red', q.status === 0, `exit=${q.status} (want 0) on a clean file`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

process.stdout.write('\n=== n09b: the REAL digest set bites (local only — needs the private list) ===\n');
{
  const denylist = process.env.DENYLIST;
  if (!denylist || !existsSync(denylist)) {
    process.stdout.write('note  n09b skipped — DENYLIST is not available here. This is expected in CI:\n');
    process.stdout.write('      the plaintext list must not exist on a public runner. n09a proves the mechanism.\n');
  } else {
    const { readFileSync: rd, writeFileSync: w, mkdtempSync: mk } = await import('node:fs');
    const tmp = mk(join(tmpdir(), 'ina-trust-n09b-'));
    try {
      const term = rd(denylist, 'utf8').split('\n').map((l) => l.replace(/#.*$/, '').trim())
        .filter(Boolean).sort((a, b) => b.length - a.length)[0] ?? '';
      const fixture = join(tmp, 'real.md');
      w(fixture, `# Fixture\n\nA page that mentions ${term} must not ship.\n`);
      const p = spawnSync('npx', ['tsx', 'scripts/guard.ts', fixture], {
        cwd: REPO, encoding: 'utf8', env: process.env,
      });
      const out = `${p.stdout ?? ''}${p.stderr ?? ''}`;
      const leaked = term.length > 3 && out.toLowerCase().includes(term.toLowerCase());
      record('n09b-real-digest-set', p.status === 1 && !leaked,
        `exit=${p.status} (want 1) leaked_plaintext=${leaked} term_tokens=${term.split(/\s+/).length}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

/* --------------------------------------------------------- drift fixture -- */
/**
 * n10 — the drift check must catch a COMMITTED build/ that no longer matches
 * the register.
 *
 * THE FIXTURE HAD TO CHANGE WITH THE GATE. It used to mutate build/trust.json,
 * which worked against the old drift check because that one compared the
 * working tree. The new check reads the COMMITTED output via `git show`, so
 * mutating the working tree proves nothing — and this fixture correctly went
 * red the moment the gate was fixed, which is what a fixture is for.
 *
 * The sabotage is now the real failure mode: edit data/credentials.yaml and
 * forget to regenerate. That is the mistake a human actually makes.
 */
process.stdout.write('\n=== n10: a register edit without a regenerate must be caught ===\n');
{
  const { readFileSync: rd, writeFileSync: w } = await import('node:fs');
  const dataFile = DATA_PATH;
  const original = rd(dataFile, 'utf8');
  try {
    w(dataFile, original.replace('platform_name: "INA GPT"', 'platform_name: "INA GPT DRIFT FIXTURE"'), 'utf8');
    const p = spawnSync('make', ['drift'], { cwd: REPO, encoding: 'utf8', env: process.env });
    const out = `${p.stdout ?? ''}${p.stderr ?? ''}`;
    record('n10-committed-output-is-stale', p.status !== 0 && /differs from a fresh render/.test(out),
      `make drift exit=${p.status} (want non-zero) named_a_stale_file=${/differs from a fresh render/.test(out)}`);
  } finally {
    // Restore the register AND the generated output, unconditionally. A fixture
    // that leaves either mutated turns every later run into a false red.
    w(dataFile, original, 'utf8');
    spawnSync('npx', ['tsx', 'scripts/generate.ts'], { cwd: REPO, encoding: 'utf8', env: process.env });
  }
}

/* ------------------------------------------------------- positive case ---- */
/**
 * The real register, with ONE knowingly-open item.
 *
 * V11 is deliberately red: two evidence links refuse automated requests from
 * this address, and nobody has confirmed them by hand, so the register declines
 * to call them verified. Asserting `exit === 0` here would force a choice
 * between a green suite and an honest register.
 *
 * So the assertion is sharper than "it passes": the ONLY failures may be those
 * two V11 items. That still catches everything a plain pass would — any new
 * violation, in any rule, breaks it — while refusing to launder the open item
 * into a green tick.
 */
process.stdout.write('\n=== positive: the real register has NO failures other than the known-open V11 ===\n');
{
  const { code, out } = runValidate(DATA_PATH);
  const lines = out.split('\n').filter((l) => /^V[0-9]+\s/.test(l));
  const onlyKnownV11 =
    lines.length === 2 &&
    lines.every((l) => l.startsWith('V11') && /last_human_verified/.test(l));
  record('positive-real-register', code === 1 && onlyKnownV11,
    `exit=${code} · ${lines.length} violation(s), all known-open V11: ${onlyKnownV11}`);
  for (const l of lines) process.stdout.write(`      open: ${l}\n`);
}

process.stdout.write(
  failures === 0
    ? `\nnegative: PASS — ${matrix.length} fixture(s), every gate demonstrably fails on its own violation\n`
    : `\nnegative: FAIL — ${failures} of ${matrix.length} fixture(s) did not behave as designed\n`
);
process.exit(failures === 0 ? 0 : 1);
