/**
 * assert-synced — is what is PUBLISHED still what the register renders?
 *
 * The sync job can be unable to run (no token) or can silently stop running,
 * and neither shows up as a broken build. This closes that: it fetches every
 * public repository's live README, extracts the block between the markers, and
 * compares it byte-for-byte against build/repo-block.md.
 *
 * It therefore catches three distinct failures the sync job cannot:
 *   - the block was never published,
 *   - the register changed and the sync did not run,
 *   - somebody hand-edited the block in a downstream repository.
 *
 * Run in the VALIDATE job, not the publish job. Validation must notice that
 * the world disagrees with the register even when publishing is impossible —
 * otherwise "we could not publish" and "we are in sync" look identical.
 *
 * Exit 0 in sync · 1 drift · 2 could not check.
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { REPO, BUILD_DIR } from './lib.ts';

const ORG = 'ina-gpt';
const START = '<!-- INA-TRUST:START -->';
const END = '<!-- INA-TRUST:END -->';

function die(msg: string): never {
  process.stderr.write(`assert-synced: FATAL ${msg}\n`);
  process.exit(2);
}

const blockPath = resolve(BUILD_DIR, 'repo-block.md');
if (!existsSync(blockPath)) die('build/repo-block.md is missing — run `make trust` first');
const expected = readFileSync(blockPath, 'utf8').trimEnd();

function gh(argv: string[]): string {
  return execFileSync('gh', argv, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

interface RepoInfo { name: string; visibility: string; isArchived: boolean }

let repos: RepoInfo[];
try {
  repos = JSON.parse(gh(['repo', 'list', ORG, '--limit', '100', '--json', 'name,visibility,isArchived'])) as RepoInfo[];
} catch (e) {
  die(`could not list repositories: ${(e as Error).message}`);
}

const targets = repos
  .filter((r) => r.visibility === 'PUBLIC' && !r.isArchived)
  .map((r) => r.name)
  .filter((n) => n !== 'trust')
  .sort();

if (targets.length === 0) die('no public repositories found — refusing to report in-sync');

const drift: string[] = [];
let checked = 0;

for (const name of targets) {
  let readme = '';
  try {
    const b64 = gh(['api', `repos/${ORG}/${name}/contents/README.md`, '--jq', '.content']);
    readme = Buffer.from(b64.replace(/\s/g, ''), 'base64').toString('utf8');
  } catch {
    drift.push(`${name}: README.md is not reachable`);
    continue;
  }
  checked++;

  const s = readme.indexOf(START);
  const e = readme.indexOf(END);
  if (s === -1 || e === -1 || e < s) {
    drift.push(`${name}: no INA-TRUST block — the generated surface was never published here`);
    continue;
  }
  const published = readme.slice(s + START.length, e).trim();
  if (published !== expected) {
    // Report the SHAPE of the difference, not the whole diff: this log is public.
    drift.push(
      `${name}: published block differs from build/repo-block.md ` +
        `(published ${published.length} chars, expected ${expected.length})`
    );
  }
}

if (checked === 0) die('no README could be read — refusing to report in-sync');

if (drift.length > 0) {
  for (const d of drift) process.stdout.write(`DRIFT  ${d}\n`);
  process.stdout.write(
    `\nassert-synced: FAIL — ${drift.length} of ${targets.length} public repo(s) disagree with the register.\n` +
      '               Run `npx tsx scripts/sync.ts` (needs a token with contents:write).\n'
  );
  process.exit(1);
}

process.stdout.write(`assert-synced: OK — ${checked} public repo(s) carry the current generated block\n`);
