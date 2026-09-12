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
  type Register, type Membership, type Mark,
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

/* --------------------------------------------------------------- V6/V10 ---- */
/**
 * R5 — a displayed mark needs a recorded permission whose digest matches the
 * bytes, AND a credential that is actually held.
 *
 * V10's second half is the one that matters. The site footer displayed the KI
 * Bundesverband mark while this register carried that membership as
 * verification_pending: two public surfaces asserting the same thing at
 * different confidence levels. A permission check alone would not have caught
 * it, because the problem was never the permission — it was that a mark is a
 * stronger claim than the credential behind it.
 *
 * `grantor` is an ORGANISATION. The individual who signed stays in the private
 * register; publishing their name would breach R8 to satisfy a field list.
 */
function v6v10Marks(r: Register) {
  const byId = new Map<string, { status: string; kind: string }>();
  for (const e of r.certifications) byId.set(e.id, { status: e.status, kind: 'certifications' });
  for (const e of r.memberships) byId.set(e.id, { status: e.status, kind: 'memberships' });
  for (const e of r.registrations) byId.set(e.id, { status: e.status, kind: 'registrations' });

  const seenFiles = new Set<string>();
  for (const [i, m] of (r.marks ?? []).entries()) {
    const at = `marks[${i}] (${m.id})`;

    const abs = resolve(REPO, m.file);
    if (!existsSync(abs)) {
      v('V10', `${at}.file`, `not found on disk: ${m.file}`);
    } else {
      const actual = sha256File(abs);
      if (actual !== m.sha256) {
        v('V10', `${at}.sha256`,
          `recorded digest does not match the file (recorded ${m.sha256.slice(0, 12)}…, actual ${actual.slice(0, 12)}…)`);
      }
    }

    if (!m.permission_evidence || m.permission_evidence.trim().length < 20) {
      v('V10', `${at}.permission_evidence`, 'a mark may not ship without evidence of the permission');
    }
    if (!m.permission_date) v('V10', `${at}.permission_date`, 'missing');

    const cred = byId.get(m.credential_ref);
    if (!cred) {
      v('V10', `${at}.credential_ref`, `does not resolve to any credential: ${m.credential_ref}`);
    } else if (cred.status !== 'held') {
      v('V10', `${at}.credential_ref`,
        `mark ${m.id} displays a credential that is not held (${m.credential_ref} is ${cred.status})`);
    }

    // A person's name in a public permission record is an R8 breach.
    //
    // The organisation allowlist below replaced
    //   /\b(GmbH|AISBL|e\.V\.|Association|Verband|Institute|Ltd|Inc|SE|AG)\b/
    // which had TWO DEAD ENTRIES, found on 2026-09-12 when it rejected
    // "Bundesverband Deutsche Startups e.V." as a natural person:
    //   - `\be\.V\.\b` can never match. The trailing \b sits after a literal
    //     ".", so it needs a word character to its right; at end-of-string or
    //     before whitespace there is none. Every "e.V." in the corpus missed.
    //   - `Verband` is case-sensitive and boundary-anchored, so it matches
    //     "Verband" but not the compound "Bundesverband", which is how most
    //     German associations actually name themselves.
    // An allowlist entry that cannot fire is a decorative allowlist. These are
    // split into explicit patterns so each one's flags are visible: the German
    // compounds are case-insensitive (they appear mid-word), while short forms
    // like AG and SE stay case-sensitive and boundary-anchored so they cannot
    // match inside a personal name.
    const ORG_MARKERS: RegExp[] = [
      /e\.\s?V\./i, /verband/i, /verein/i, /gesellschaft/i, /genossenschaft/i,
      /association/i, /institut/i, /stiftung/i, /foundation/i, /alliance/i,
      /federation/i, /council/i, /chamber/i, /kammer/i, /society/i, /consortium/i,
      /\bAISBL\b/i, /\bASBL\b/i, /\bLtd\b/i, /\bInc\b/i, /\bLLC\b/i, /\bBV\b/i,
      /\bGmbH\b/, /\bgGmbH\b/, /\bmbH\b/, /\bAG\b/, /\bSE\b/, /\bKG\b/, /\bOHG\b/,
    ];
    // STRIP the markers and look at what is LEFT. An allowlist alone launders a
    // personal name the moment an organisational word is appended to it:
    // "Jane Doe Institut" satisfied /institut/i and sailed through, which the
    // n19 fixture caught. If removing every organisational token leaves a bare
    // two-word personal name, it IS a personal name with a word stapled on.
    //
    //   "Jane Doe Institut"                     -> "Jane Doe"                 PERSON
    //   "Bundesverband Deutsche Startups e.V."  -> "Bundes Deutsche Startups" ORG
    //   "TÜV SÜD Management Service GmbH"       -> "TÜV SÜD Management Service" ORG
    //
    // Known limitation, stated rather than hidden: a two-word personal name
    // followed by a strong legal form ("Jane Doe GmbH") is indistinguishable
    // from a one-person company, and is accepted. That is the correct answer —
    // a sole-trader company IS the organisation — but it means this rule is a
    // guard against carelessness, not against a determined author.
    const stripped = ORG_MARKERS.reduce((acc, r) => acc.replace(new RegExp(r.source, r.flags.includes('i') ? 'gi' : 'g'), ' '), m.grantor)
      .replace(/[\u2013\u2014,.;:]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const bareName = /^[A-ZÄÖÜ][a-zäöüß]+\s+[A-ZÄÖÜ][a-zäöüß]+$/.test(stripped);
    const looksOrganisational = ORG_MARKERS.some((r) => r.test(m.grantor)) && !bareName;
    if (/\b[A-ZÄÖÜ][a-zäöüß]+\s+[A-ZÄÖÜ][a-zäöüß]+\b/.test(m.grantor) && !looksOrganisational) {
      v('V10', `${at}.grantor`, 'looks like a natural person; the grantor must be the granting ORGANISATION (R8)');
    }

    if (seenFiles.has(m.file)) v('V10', `${at}.file`, `two marks claim the same file: ${m.file}`);
    seenFiles.add(m.file);
  }

  // The old per-membership `logo` field is superseded by marks[] and must not
  // come back: two registers for one fact is how they diverge.
  for (const [i, e] of r.memberships.entries()) {
    if ((e as Membership & { logo?: string }).logo) {
      v('V10', `memberships[${i}].logo`,
        'superseded by the marks[] register — declare the mark there so V10 can check its credential status');
    }
  }
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
/**
 * R4 — Fundstelle duty: the mark or the number obliges the reference link.
 *
 * LOCALE-AWARE, because the certifier's artwork is. OCR of the deployed marks
 * (2026-09-12) shows the English badge carries /ms-cert and the German badge
 * carries /ms-zert — the same Fundstelle in two languages. A surface satisfies
 * this rule by carrying EITHER, because a generated English page paired with
 * the English badge is correct and so is the German pair. What is not correct
 * is carrying neither, which is what the footer did: the URL existed only as
 * pixels inside the artwork.
 */
function v8Fundstelle(r: Register, files: Array<{ path: string; text: string }>) {
  const cert = r.certifications.find((c) => c.fundstelle_required);
  const number = cert?.identifier;
  const accepted = cert?.fundstelle_url
    ? [cert.fundstelle_url.en, cert.fundstelle_url.de]
    : [FUNDSTELLE_URL];
  for (const { path, text } of files) {
    const mentionsNumber = Boolean(number && text.includes(number));
    const mentionsMark = /T(?:Ü|U)V\s*S(?:Ü|U)D/i.test(text);
    if (!mentionsNumber && !mentionsMark) continue;
    if (!accepted.some((u) => text.includes(u))) {
      v('V8', path,
        `mentions the certificate number or the TÜV SÜD mark but carries no Fundstelle link (expected one of: ${accepted.join(', ')})`);
    }
  }
}

/* ----------------------------------------------------------------- V11 ---- */
/**
 * A blocked evidence link is not a pass by itself.
 *
 * Two registries answer 403 to every automated request from a datacenter
 * address. The link checker correctly refuses to call those dead — but that
 * leaves a claim whose primary source nothing has ever confirmed. So where a
 * link is declared un-machine-checkable, a HUMAN confirmation carries it, and
 * it expires: 180 days, after which the claim is unverified again.
 *
 * This is the honest shape of "we could not check". Without the expiry, the
 * flag would be a permanent exemption wearing the word "verified".
 */
const HUMAN_VERIFY_MAX_AGE_DAYS = 180;

/**
 * V12 — a `held` claim must name HOW it is backed.
 *
 * Added 2026-09-12, when a membership that is genuinely held could not be
 * recorded as such: its member-directory entry is not live, so there is no
 * public URL, and the register had only one shape for evidence — a link. The
 * honest answer is not to weaken `held`; it is to say which KIND of evidence
 * stands behind it.
 *
 *   public_registry     evidence_url must be present. Anyone can open it.
 *   document_on_request document_ref must name the document AND its date.
 *
 * The date is the load-bearing half. "The confirmation email" is not a
 * reference; "Aufnahmebestätigung, 2026-07-14" is. A tier is therefore never a
 * softer pass — it is a different, equally checkable obligation, and an entry
 * that declares document_on_request without a date fails here.
 *
 * Legacy tolerance, deliberately narrow: an entry with NO tier declared is
 * judged the old way (a held entry needs evidence_url). That keeps this from
 * becoming a flag day across a register that predates it, while any entry that
 * opts into a tier is held to it.
 */
function v12EvidenceTier(reg: Register) {
  const groups: Array<[string, Array<{ id: string; status: string; evidence_url?: string | null }>]> = [
    ['registrations', reg.registrations],
    ['certifications', reg.certifications],
    ['memberships', reg.memberships],
  ];
  for (const [name, list] of groups) {
    list.forEach((c, i) => {
      const at = `${name}[${i}] (${c.id})`;
      const tier = (c as { evidence_tier?: string }).evidence_tier;
      const docRef = (c as { document_ref?: string }).document_ref;
      if (tier === 'document_on_request') {
        if (c.status !== 'held') {
          v('V12', `${at}.evidence_tier`, 'document_on_request describes how a HELD claim is backed; it means nothing on an unheld entry');
        }
        if (!docRef || docRef.trim().length < 12) {
          v('V12', `${at}.document_ref`, 'document_on_request requires document_ref naming the document');
        } else if (!/\b(19|20)\d{2}-\d{2}-\d{2}\b/.test(docRef)) {
          v('V12', `${at}.document_ref`, `must carry the document's DATE as YYYY-MM-DD — "${docRef}" names a document but not when it was issued, and an undated reference cannot be checked`);
        }
      } else if (tier === 'public_registry') {
        if (!c.evidence_url) {
          v('V12', `${at}.evidence_url`, 'public_registry claims the evidence is openable by anyone, so a URL is mandatory');
        }
      } else if (c.status === 'held' && !c.evidence_url) {
        v('V12', `${at}.evidence_tier`, 'a held credential needs either a public evidence_url or an explicit evidence_tier: document_on_request with a dated document_ref');
      }
    });
  }
}

function v11HumanVerification(r: Register) {
  const all: Array<{ at: string; e: { machine_checkable?: boolean; last_human_verified?: string; status: string } }> = [
    ...r.certifications.map((e, i) => ({ at: `certifications[${i}] (${e.id})`, e })),
    ...r.registrations.map((e, i) => ({ at: `registrations[${i}] (${e.id})`, e })),
    ...r.memberships.map((e, i) => ({ at: `memberships[${i}] (${e.id})`, e })),
  ];
  const today = todayUTC();
  for (const { at, e } of all) {
    if (e.machine_checkable !== false) continue;
    if (e.status !== 'held') continue;
    if (!e.last_human_verified) {
      v('V11', `${at}.last_human_verified`,
        'evidence link cannot be machine-checked, so a dated human verification is required');
      continue;
    }
    const age = daysBetween(e.last_human_verified, today);
    if (age > HUMAN_VERIFY_MAX_AGE_DAYS) {
      v('V11', `${at}.last_human_verified`,
        `human verification is ${age} days old (${e.last_human_verified}); the limit is ${HUMAN_VERIFY_MAX_AGE_DAYS}`);
    } else if (age > HUMAN_VERIFY_MAX_AGE_DAYS - 30) {
      notices.push(`HUMAN-VERIFY ${at} was verified ${age} days ago — re-confirm within ${HUMAN_VERIFY_MAX_AGE_DAYS - age} day(s)`);
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
  v6v10Marks(register);
  v11HumanVerification(register);
  v12EvidenceTier(register);
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
  `validate: OK — schema + R1/R3/R4/R5/R8 + V10 marks + V11 human-verify + expiry + determinism · ` +
    `${surfaces.length} surface(s) scanned · ${notices.length} notice(s)\n`
);
