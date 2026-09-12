/**
 * validate — the rule engine. V1..V9, in order, each naming the offending path.
 *
 * Every rule here exists because a compliance page can be wrong in a way that
 * still renders beautifully. Schema validation catches a malformed register;
 * these catch a well-formed register that makes a claim nobody can check.
 *
 * Exit 0 clean · 1 a rule failed · 2 the check could not run.
 *
 * "Could not run" is a distinct code on purpose. A validator that cannot read
 * its schema and exits 0 is worse than no validator, because the green tick is
 * then evidence of nothing.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  REPO, DATA_PATH, SCHEMA_PATH, BUILD_DIR, FUNDSTELLE_URL,
  loadRegister, roundTrip, sha256File, todayUTC, daysBetween,
  type Register, type Membership,
} from './lib.ts';

const args = process.argv.slice(2);
const dataArg = args.find((a) => a.startsWith('--data='));
const DATA = dataArg ? resolve(dataArg.slice('--data='.length)) : DATA_PATH;
const LOGO_USAGE = resolve(REPO, 'logos/LOGO-USAGE.md');

const violations: string[] = [];
const notices: string[] = [];

function v(rule: string, path: string, msg: string) {
  violations.push(`${rule}  ${path}: ${msg}`);
}

/* ------------------------------------------------------------------ V1 ---- */
function v1Schema(raw: unknown): Register {
  if (!existsSync(SCHEMA_PATH)) {
    process.stderr.write(`FATAL schema not found: ${SCHEMA_PATH}\n`);
    process.exit(2);
  }
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  const validateFn = ajv.compile(schema);
  if (!validateFn(raw)) {
    for (const e of validateFn.errors ?? []) {
      v('V1', e.instancePath || '/', `${e.message ?? 'schema error'}${e.params ? ` ${JSON.stringify(e.params)}` : ''}`);
    }
  }
  return raw as Register;
}

/* ------------------------------------------------------------------ V2 ---- */
/**
 * R1 — `held` must be checkable.
 *
 * The identifier requirement has one carve-out, and it is narrow: a membership
 * that appears in a public member directory is verifiable by NAME at that
 * directory, so a membership number adds nothing a reader needs. Everything
 * else — certifications, legal registrations — must carry an identifier,
 * because "we are certified, trust us" is the claim this whole repository
 * exists to make impossible.
 */
function v2HeldIsVerifiable(r: Register) {
  for (const [i, e] of r.certifications.entries()) {
    if (e.status !== 'held') continue;
    if (!e.identifier) v('V2', `certifications[${i}].identifier`, 'status "held" requires an identifier');
    if (!e.issuer) v('V2', `certifications[${i}].issuer`, 'status "held" requires an issuer');
    if (!e.evidence_url) v('V2', `certifications[${i}].evidence_url`, 'status "held" requires a primary-source link');
    if (e.valid_to && !e.valid_from) v('V2', `certifications[${i}].valid_from`, 'valid_to present without valid_from');
  }
  for (const [i, e] of r.registrations.entries()) {
    if (e.status !== 'held') continue;
    if (!e.identifier) v('V2', `registrations[${i}].identifier`, 'status "held" requires an identifier');
    if (!e.evidence_url) v('V2', `registrations[${i}].evidence_url`, 'status "held" requires a primary-source link');
  }
  for (const [i, e] of r.memberships.entries()) {
    if (e.status !== 'held') continue;
    if (!e.evidence_url) {
      v('V2', `memberships[${i}].evidence_url`, 'status "held" requires a primary-source link');
      continue;
    }
    // Directory-listed membership: the link IS the verification.
    if (!e.identifier && !e.evidence_url) {
      v('V2', `memberships[${i}].identifier`, 'status "held" requires an identifier or a member-directory link');
    }
  }
}

/* ------------------------------------------------------------------ V3 ---- */
function v3Iso42001NotHeld(r: Register) {
  const e = r.certifications.find((c) => c.id === 'iso-42001');
  if (!e) return;
  if (e.status !== 'in_progress') {
    v('V3', 'certifications[iso-42001].status', `must be "in_progress" — no certificate has been issued; found "${e.status}"`);
  }
}

/* --------------------------------------------------------------- V4 / V5 -- */
function v4v5Expiry(r: Register) {
  const today = todayUTC();
  for (const [i, e] of r.certifications.entries()) {
    if (!e.valid_to) continue;
    const remaining = daysBetween(today, e.valid_to);
    if (remaining < 0) {
      v('V4', `certifications[${i}].valid_to`, `expired ${-remaining} day(s) ago (${e.valid_to})`);
      continue;
    }
    for (const horizon of [30, 90, 180]) {
      if (remaining <= horizon) {
        notices.push(`RENEWAL certifications[${i}] (${e.id}) expires in ${remaining} day(s) on ${e.valid_to} — inside the ${horizon}-day horizon`);
        break;
      }
    }
  }
}

/* ------------------------------------------------------------------ V6 ---- */
/**
 * R5 — a third-party mark needs a recorded permission, and the record must
 * match the bytes on disk.
 *
 * DIVERGENCE FROM THE SPEC, DELIBERATE: the spec asked for `grantor` in this
 * public file. The grantor of a logo permission is a named individual at
 * another organisation — their name, role and address are personal data with no
 * lawful basis for publication (the estate's private register says so in as
 * many words, and R8 forbids it here). So the PUBLIC record names the granting
 * ORGANISATION and the permission date; the individual stays in the private
 * register. R8 outranks R5's field list, and a rule that forced a GDPR breach
 * to satisfy a checklist would be the wrong rule.
 */
function v6LogoPermissions(r: Register) {
  const withLogos = r.memberships.filter((m): m is Membership & { logo: string } => Boolean(m.logo));
  if (withLogos.length === 0) return;

  if (!existsSync(LOGO_USAGE)) {
    for (const m of withLogos) {
      v('V6', `memberships[${m.id}].logo`, 'logos/LOGO-USAGE.md does not exist — a mark may not ship without a permission record');
    }
    return;
  }
  const usage = readFileSync(LOGO_USAGE, 'utf8');

  for (const m of withLogos) {
    const abs = resolve(REPO, m.logo);
    if (!existsSync(abs)) {
      v('V6', `memberships[${m.id}].logo`, `file not found on disk: ${m.logo}`);
      continue;
    }
    const block = extractBlock(usage, m.logo);
    if (!block) {
      v('V6', `memberships[${m.id}].logo`, `no permission block for ${m.logo} in logos/LOGO-USAGE.md`);
      continue;
    }
    for (const field of ['grantor_organisation', 'permission_date', 'source_url', 'sha256']) {
      if (!new RegExp(`^${field}:\\s*\\S`, 'm').test(block)) {
        v('V6', `logos/LOGO-USAGE.md[${m.logo}].${field}`, 'missing from the permission block');
      }
    }
    const recorded = /^sha256:\s*([0-9a-f]{64})\s*$/m.exec(block)?.[1];
    const actual = sha256File(abs);
    if (recorded && recorded !== actual) {
      v('V6', `logos/LOGO-USAGE.md[${m.logo}].sha256`, `recorded digest does not match the file (recorded ${recorded.slice(0, 12)}…, actual ${actual.slice(0, 12)}…)`);
    }
  }
}

/** A permission block runs from its `## <path>` heading to the next heading. */
function extractBlock(md: string, logoPath: string): string | null {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${logoPath}`);
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

/* ------------------------------------------------------------------ V7 ---- */
/**
 * R8 — no private personal data, anywhere public.
 *
 * Implemented as regex FAMILIES rather than a list of the founder's private
 * values, for the reason the spec gives: a literal list of the things you must
 * not publish is itself a file you must not publish. These patterns describe
 * the SHAPE of private contact data and are safe to read.
 */
const BUSINESS_PHONE_DIGITS = '493042432400';
const ALLOWED_EMAIL = /^(info|security|support|privacy|dpo|legal|press|jobs|abuse)@inagpt\.com$/i;

function v7NoPrivateContact(files: Array<{ path: string; text: string }>) {
  for (const { path, text } of files) {
    // Any email address that is not an INA role address.
    for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
      const addr = m[0];
      if (ALLOWED_EMAIL.test(addr)) continue;
      // Third-party addresses in evidence URLs are not contact data; but an
      // address in a public trust file has no other reason to be there.
      v('V7', path, `non-role email address present (${addr[0]}…@…, ${addr.length} chars) — business contact only`);
    }
    // Any phone number that is not the registered business number.
    for (const m of text.matchAll(/\+[0-9][0-9\s().-]{7,}[0-9]/g)) {
      const digits = m[0].replace(/\D/g, '');
      if (digits === BUSINESS_PHONE_DIGITS) continue;
      v('V7', path, `phone number that is not the registered business number (${digits.length} digits)`);
    }
    // A German residential-style address line that is not the registered seat.
    for (const m of text.matchAll(/\b([A-ZÄÖÜ][a-zäöüß]+(?:weg|straße|strasse|str\.|allee|platz|gasse|damm|ufer))\s+(\d+\s*[A-Za-z]?)\b/g)) {
      const line = `${m[1]} ${m[2]}`.replace(/\s+/g, ' ').trim();
      if (/^Selerweg 40 A$/i.test(line)) continue;
      v('V7', path, `street address that is not the registered seat (${line.slice(0, 3)}…)`);
    }
  }
}

/* ------------------------------------------------------------------ V8 ---- */
/** R4 — Fundstelle duty: the mark or the number obliges the reference link. */
function v8Fundstelle(r: Register, files: Array<{ path: string; text: string }>) {
  const cert = r.certifications.find((c) => c.fundstelle_required);
  const number = cert?.identifier;
  for (const { path, text } of files) {
    const mentionsNumber = Boolean(number && text.includes(number));
    const mentionsMark = /T(?:Ü|U)V\s*S(?:Ü|U)D/i.test(text);
    if (!mentionsNumber && !mentionsMark) continue;
    if (!text.includes(FUNDSTELLE_URL)) {
      v('V8', path, `mentions the certificate number or the TÜV SÜD mark but does not carry the Fundstelle link ${FUNDSTELLE_URL}`);
    }
  }
}

/* ------------------------------------------------------------------ V9 ---- */
function v9Determinism(r: Register) {
  const a = JSON.stringify(r);
  const b = JSON.stringify(roundTrip(r));
  if (a !== b) v('V9', 'data/credentials.yaml', 'serialize→parse is not byte-identical; the register is not deterministic');
}

/* -------------------------------------------------------------- collect --- */
function textFiles(dir: string): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  if (!existsSync(dir)) return out;
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const abs = join(d, name);
      if (statSync(abs).isDirectory()) { walk(abs); continue; }
      if (!/\.(md|json|txt|ya?ml)$/i.test(name)) continue;
      out.push({ path: relative(REPO, abs), text: readFileSync(abs, 'utf8') });
    }
  };
  walk(dir);
  return out;
}

/* ----------------------------------------------------------------- main --- */
const raw = loadRegister(DATA);
const register = v1Schema(raw);

// Rules that read the register itself.
if (violations.length === 0) {
  v2HeldIsVerifiable(register);
  v3Iso42001NotHeld(register);
  v4v5Expiry(register);
  v6LogoPermissions(register);
  v9Determinism(register);
}

// Rules that read the register AND every generated surface.
const surfaces = [{ path: relative(REPO, DATA), text: readFileSync(DATA, 'utf8') }, ...textFiles(BUILD_DIR)];
v7NoPrivateContact(surfaces);
v8Fundstelle(register, surfaces);

for (const n of notices) process.stdout.write(`notice  ${n}\n`);

if (violations.length > 0) {
  for (const line of violations) process.stdout.write(`${line}\n`);
  process.stdout.write(`\nvalidate: FAIL — ${violations.length} violation(s)\n`);
  process.exit(1);
}

process.stdout.write(
  `validate: OK — schema + R1/R3/R4/R5/R8 + expiry + determinism · ` +
    `${surfaces.length} surface(s) scanned · ${notices.length} notice(s)\n`
);
