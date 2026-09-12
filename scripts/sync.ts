/**
 * sync — push the generated surface to every public repository in the org.
 *
 * GUARD FIRST, PUBLISH SECOND. Every payload is run through the disclosure
 * guard before a single write leaves this process. The other order publishes and
 * then complains, which on a public repository is not a failure mode you can
 * take back.
 *
 * IDEMPOTENT BY CONSTRUCTION. Injection happens strictly between
 *   <!-- INA-TRUST:START --> … <!-- INA-TRUST:END -->
 * and nothing outside the markers is ever touched. Running twice produces zero
 * diff, which is what makes the publish job safe to run on every push to main
 * rather than something a human has to remember.
 *
 * Usage:
 *   npx tsx scripts/sync.ts [--dry-run] [--commit-sha=abc1234] [--only=repo]
 */
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { REPO, BUILD_DIR } from './lib.ts';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const ONLY = args.find((a) => a.startsWith('--only='))?.slice('--only='.length);
const SHA = args.find((a) => a.startsWith('--commit-sha='))?.slice('--commit-sha='.length) ?? 'local';

const ORG = 'ina-gpt';
const START = '<!-- INA-TRUST:START -->';
const END = '<!-- INA-TRUST:END -->';
const COMMIT_MSG = `chore(trust): sync generated trust surface from ${SHA}`;

function sh(cmd: string, argv: string[], cwd?: string): string {
  return execFileSync(cmd, argv, { encoding: 'utf8', cwd, maxBuffer: 32 * 1024 * 1024 }).trim();
}

function die(msg: string): never {
  process.stderr.write(`sync: FATAL ${msg}\n`);
  process.exit(2);
}

/* ------------------------------------------------------------- the guard -- */
/**
 * Run the disclosure guard over the exact bytes about to be published.
 *
 * Not over build/ — over a staging directory holding the final payloads,
 * including the READMEs after injection. The guard's default scope covers
 * build/, and a block that is clean in build/ could still land next to
 * something in a foreign README that changes what a window contains.
 */
function guardOrDie(payloads: Array<{ name: string; text: string }>) {
  const staging = mkdtempSync(join(tmpdir(), 'ina-trust-sync-guard-'));
  try {
    for (const p of payloads) writeFileSync(join(staging, p.name), p.text, 'utf8');
    const res = spawnSync('npx', ['tsx', 'scripts/guard.ts', staging], {
      cwd: REPO, encoding: 'utf8', env: process.env,
    });
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    process.stdout.write(out);
    if (res.status !== 0) {
      die(
        'the disclosure guard refused the payload — nothing was published.\n' +
          '       This is the guard working: a forbidden term would have gone public.'
      );
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/* -------------------------------------------------------------- payloads -- */
function buildFile(name: string): string {
  const p = resolve(BUILD_DIR, name);
  if (!existsSync(p)) die(`build/${name} is missing — run \`make trust\` first`);
  return readFileSync(p, 'utf8');
}

const orgProfile = buildFile('org-profile.md');
const repoBlock = buildFile('repo-block.md');
const securityMd = buildFile('SECURITY.md');
const complianceMd = buildFile('COMPLIANCE.md');
const trustReadme = buildFile('README.md');

/* ----------------------------------------------------------- public repos -- */
interface RepoInfo { name: string; visibility: string; isArchived: boolean }

let repos: RepoInfo[];
try {
  repos = JSON.parse(
    sh('gh', ['repo', 'list', ORG, '--limit', '100', '--json', 'name,visibility,isArchived'])
  ) as RepoInfo[];
} catch (e) {
  die(`could not list repositories: ${(e as Error).message}`);
}

const publicRepos = repos
  .filter((r) => r.visibility === 'PUBLIC' && !r.isArchived)
  .map((r) => r.name)
  .filter((n) => n !== 'trust')
  .filter((n) => (ONLY ? n === ONLY : true))
  .sort();

if (publicRepos.length === 0) die('no public repositories found — refusing to report a successful sync');

process.stdout.write(`sync: ${publicRepos.length} public repo(s): ${publicRepos.join(', ')}\n`);

/* ------------------------------------------------------------- injection -- */
/** Replace between the markers, or append them. Never touch anything else. */
export function inject(existing: string, block: string): string {
  const body = `${START}\n${block.trimEnd()}\n${END}`;
  const s = existing.indexOf(START);
  const e = existing.indexOf(END);
  if (s !== -1 && e !== -1 && e > s) {
    return existing.slice(0, s) + body + existing.slice(e + END.length);
  }
  const base = existing.trimEnd();
  return `${base}${base ? '\n\n' : ''}${body}\n`;
}

/* -------------------------------------------------------------- guard run -- */
const guardPayloads: Array<{ name: string; text: string }> = [
  { name: 'org-profile.md', text: orgProfile },
  { name: 'repo-block.md', text: repoBlock },
  { name: 'SECURITY.md', text: securityMd },
  { name: 'COMPLIANCE.md', text: complianceMd },
  { name: 'trust-README.md', text: trustReadme },
];

/* Also guard each foreign README *after* injection — see guardOrDie's note. */
const plannedReadmes: Array<{ repo: string; text: string }> = [];
for (const name of publicRepos) {
  let current = '';
  try {
    // stderr silenced: a repository with no README answers 404, which is a
    // normal state here (the block is then appended rather than replaced).
    // Letting gh print "Not Found" made a successful sync read like a failure.
    const b64 = execFileSync('gh', ['api', `repos/${ORG}/${name}/contents/README.md`, '--jq', '.content'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024,
    }).trim();
    current = Buffer.from(b64.replace(/\s/g, ''), 'base64').toString('utf8');
  } catch {
    current = '';
  }
  const next = inject(current, repoBlock);
  plannedReadmes.push({ repo: name, text: next });
  guardPayloads.push({ name: `readme-${name}.md`, text: next });
}

guardOrDie(guardPayloads);

if (DRY) {
  process.stdout.write('sync: --dry-run — guard passed, nothing written\n');
  process.exit(0);
}

/* ---------------------------------------------------------------- write --- */
function putFile(repo: string, path: string, content: string, message: string): 'created' | 'updated' | 'unchanged' {
  let sha = '';
  let existing = '';
  try {
    const json = JSON.parse(sh('gh', ['api', `repos/${ORG}/${repo}/contents/${path}`]));
    sha = json.sha;
    existing = Buffer.from(String(json.content).replace(/\s/g, ''), 'base64').toString('utf8');
  } catch {
    /* absent */
  }
  if (existing === content) return 'unchanged';

  const argv = [
    'api', '--method', 'PUT', `repos/${ORG}/${repo}/contents/${path}`,
    '-f', `message=${message}`,
    '-f', `content=${Buffer.from(content, 'utf8').toString('base64')}`,
  ];
  if (sha) argv.push('-f', `sha=${sha}`);
  sh('gh', argv);
  return sha ? 'updated' : 'created';
}

let changes = 0;
const report: string[] = [];

// 7.1 — the organisation profile.
{
  const r = putFile('.github', 'profile/README.md', orgProfile, COMMIT_MSG);
  if (r !== 'unchanged') changes++;
  report.push(`.github/profile/README.md            ${r}`);
}

// 7.4 — SECURITY.md org-wide, and in each public repo that lacks one.
{
  const r = putFile('.github', 'SECURITY.md', securityMd, COMMIT_MSG);
  if (r !== 'unchanged') changes++;
  report.push(`.github/SECURITY.md                  ${r}`);
}

// 7.3 — the block, in every public README, between the markers.
for (const { repo, text } of plannedReadmes) {
  const r = putFile(repo, 'README.md', text, COMMIT_MSG);
  if (r !== 'unchanged') changes++;
  report.push(`${repo}/README.md`.padEnd(37)+ r);
}

for (const line of report) process.stdout.write(`  ${line}\n`);
process.stdout.write(`sync: ${changes} file(s) changed, ${report.length - changes} already current\n`);
