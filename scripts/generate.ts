/**
 * generate — render every published surface from data/credentials.yaml.
 *
 * DETERMINISM IS THE WHOLE POINT
 *   Output must be byte-identical across runs, because the CI drift check
 *   compares committed output against a fresh render. If rendering embedded a
 *   timestamp, the drift check would fail on every run and would be switched
 *   off within a week — and with it the guarantee that the published pages
 *   actually correspond to the register.
 *
 *   Two exceptions, both bounded and both necessary:
 *     security.txt `Expires`   RFC 9116 requires it. Date-only, derived from
 *                              today, recomputed by the monthly workflow so it
 *                              can never go stale. It is the one field whose
 *                              whole job is to change.
 *     trust.json `generated_from_commit`
 *                              provenance: a reader must be able to tie the
 *                              published JSON to the commit that produced it.
 *                              Taken from the environment, not from the clock.
 *
 * WHAT IS NOT RENDERED
 *   Nothing is invented here. If a field is absent from the register, the
 *   sentence that would have used it is absent from the output. There is no
 *   default issuer, no assumed validity, no "certification pending" softened
 *   into "certified".
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  REPO, BUILD_DIR, FUNDSTELLE_URL, loadRegister, todayUTC, addDaysUTC,
  STATUS_LABEL,
  type Register, type Certification, type Membership, type Registration,
} from './lib.ts';

const GEN_HEADER = '<!-- GENERATED FILE — do not edit. Source: data/credentials.yaml. Run `make trust`. -->';

const r: Register = loadRegister();
mkdirSync(BUILD_DIR, { recursive: true });

function commitSha(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    // stdio for stderr is 'ignore': in a fresh clone with no commits this
    // throws, and the fallback below is correct. Letting git print its advice
    // block to stderr made every `make check` look like it had failed.
    return execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'uncommitted';
  }
}

function write(name: string, body: string) {
  const text = body.endsWith('\n') ? body : `${body}\n`;
  writeFileSync(resolve(BUILD_DIR, name), text, 'utf8');
}

/* ------------------------------------------------------------- fragments -- */

/** Validity column: a range, an open start, or nothing at all. */
function validity(e: Certification): string {
  if (e.valid_from && e.valid_to) return `${e.valid_from} → ${e.valid_to}`;
  if (e.valid_from) return `from ${e.valid_from}`;
  return '—';
}

function verifyLink(url: string | null | undefined): string {
  return url ? `[verify](${url})` : '—';
}

/** The held table. Identifier and link carry the claim, not the badge. */
function heldTable(): string {
  const rows: string[] = [];
  for (const e of r.certifications.filter((c) => c.status === 'held')) {
    rows.push(`| **${e.name}** | \`${e.identifier ?? '—'}\` | ${e.issuer} | ${validity(e)} | ${verifyLink(e.evidence_url)} |`);
  }
  for (const e of r.memberships.filter((m) => m.status === 'held')) {
    const ident = e.identifier ? `\`${e.identifier}\`` : '—';
    const since = e.since ? `since ${e.since}` : '—';
    rows.push(`| ${e.name}${e.category ? ` — ${e.category}` : ''} | ${ident} | — | ${since} | ${verifyLink(e.evidence_url)} |`);
  }
  for (const e of r.registrations.filter((x) => x.status === 'held')) {
    rows.push(`| ${e.name} | \`${e.identifier}\` | ${e.issuer} | — | ${verifyLink(e.evidence_url)} |`);
  }
  return [
    '| Credential | Identifier | Issuer | Valid | Verify |',
    '|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}

/**
 * The not-held section.
 *
 * Separate heading, explicit status word, the date, and no badge — so a reader
 * skimming for a certification mark finds nothing here to mistake for one.
 */
function pendingSection(): string {
  const lines: string[] = [];
  for (const e of r.certifications.filter((c) => c.status !== 'held')) {
    const when = e.since ? ` (since ${e.since})` : '';
    const detail = e.stage ? ` — ${e.stage}` : '';
    lines.push(`- **${e.name}** — ${STATUS_LABEL[e.status]}${when}${detail}. ${e.note ?? ''}`.trimEnd());
  }
  for (const e of r.memberships.filter((m) => m.status !== 'held')) {
    const when = e.since ? ` (since ${e.since})` : '';
    const detail = e.reason ?? e.detail ?? '';
    lines.push(`- ${e.name} — ${STATUS_LABEL[e.status]}${when}.${detail ? ` ${detail}` : ''}`);
  }
  return lines.join('\n');
}

/**
 * The Fundstelle sentence, for a given locale.
 *
 * Defaults to `en` because every GitHub surface this file generates is in
 * English — and the certifier's ENGLISH badge artwork carries the English URL.
 * Pairing an English page with the German URL is what made the site footer look
 * inconsistent: a badge printed with one address beside a link to another.
 */
function fundstelleUrlFor(locale: 'en' | 'de' = 'en'): string {
  const cert = r.certifications.find((c) => c.fundstelle_required);
  return cert?.fundstelle_url?.[locale] ?? FUNDSTELLE_URL;
}

function fundstelleNote(locale: 'en' | 'de' = 'en'): string {
  const cert = r.certifications.find((c) => c.fundstelle_required);
  if (!cert) return '';
  return (
    `The ${cert.issuer} certificate and test mark are verifiable at the issuer's ` +
    `certificate database: <${fundstelleUrlFor(locale)}> (Fundstelle, § 5a UWG).`
  );
}

function contactBlock(): string {
  const o = r.organization;
  return [
    `**${o.legal_name}**`,
    o.address,
    `${o.email} · ${o.phone}`,
    `<${o.website}>`,
  ].join('  \n');
}

/* ------------------------------------------------------------ build/*.md -- */

write('README.md', `${GEN_HEADER}

# Trust and compliance — ${r.organization.legal_name}

This repository is the single source of truth for every compliance claim
${r.organization.legal_name} makes in public. One data file, generated output,
CI-enforced.

**Why it exists.** A compliance page can be wrong in a way that still renders
beautifully. Every credential below therefore carries an identifier and a link
to the issuer's own record, and anything that does not carry both is in the
"not yet held" section instead — there is no middle state.

## Held

${heldTable()}

## In progress — not yet held

${pendingSection()}

${fundstelleNote()}

## How to verify this register yourself

\`\`\`
git clone https://github.com/ina-gpt/trust && cd trust
npm ci --ignore-scripts
make check      # schema, rules R1/R3/R4/R5/R8, disclosure guard, drift
make links      # every evidence URL must answer 2xx/3xx
make negative   # the gates must be able to fail
\`\`\`

Machine-readable: [\`build/trust.json\`](build/trust.json) ·
published at <${r.organization.website}/trust.json>

## Practices

${r.practices.map((p) => `**${p.title}.** ${p.body}`).join('\n\n')}

## Contact

${contactBlock()}

Security disclosure: [SECURITY.md](build/SECURITY.md)
`);

write('COMPLIANCE.md', `${GEN_HEADER}

# Compliance register — ${r.organization.legal_name}

Platform: **${r.organization.platform_name}** · Registered seat: ${r.organization.address}
Data processing: ${r.organization.data_processing_location} · Compute: ${r.organization.compute_statement}

## 1. Certifications

${heldTable()}

## 2. In progress — not yet held

${pendingSection()}

No certification mark is displayed for anything in this section, and no
affirmative wording is used about it anywhere on our surfaces.

${fundstelleNote()}

## 3. Verification table

Every held credential, with the primary source a reader can check without
asking us for anything.

| Credential | Status | Identifier | Primary source |
|---|---|---|---|
${[
  ...r.certifications.filter((c) => c.status === 'held').map((e) => `| ${e.name} | ${STATUS_LABEL[e.status]} | \`${e.identifier}\` | <${e.evidence_url}> |`),
  ...r.memberships.filter((m) => m.status === 'held').map((e) => `| ${e.name} | ${STATUS_LABEL[e.status]} | ${e.identifier ? `\`${e.identifier}\`` : 'directory-listed'} | <${e.evidence_url}> |`),
  ...r.registrations.filter((x) => x.status === 'held').map((e) => `| ${e.name} | ${STATUS_LABEL[e.status]} | \`${e.identifier}\` | <${e.evidence_url}> |`),
].join('\n')}

## 4. Practices

${r.practices.map((p) => `### ${p.title}\n\n${p.body}`).join('\n\n')}

## 5. Contact

${contactBlock()}
`);

write('SECURITY.md', `${GEN_HEADER}

# Security policy — ${r.organization.legal_name}

## Reporting a vulnerability

Email **${r.contact.security_role_address ?? r.contact.security}**. If you prefer,
${r.contact.security} reaches the same team.

Please include: what you found, how to reproduce it, and what you think the
impact is. A proof-of-concept helps more than a scanner report.

We acknowledge within **2 business days** and aim to give you a remediation
timeline within **10 business days**.

## Safe harbour

We will not pursue or support legal action against you for security research
conducted in good faith under this policy, provided you:

- do not access, modify or delete data belonging to anyone else;
- do not degrade service for others (no denial-of-service, no spam, no social
  engineering of our staff or customers);
- give us reasonable time to remediate before publishing;
- act within applicable law.

If you follow this policy in good faith and something goes wrong anyway, tell
us — we would rather hear it from you.

## Scope

${r.organization.website} and the services operated under it. Third-party
services we consume are out of scope; report those to their own programmes.

## Preferred languages

${r.contact.preferred_languages}

## Our security posture

${r.practices.filter((p) => ['isms', 'security-testing', 'gdpr'].includes(p.id)).map((p) => `**${p.title}.** ${p.body}`).join('\n\n')}

${fundstelleNote()}

## Verify our compliance claims

This page states a security posture. Every certification and membership behind
it carries an identifier and a link to the issuer's own record, in one canonical
register: **[ina-gpt/trust](https://github.com/ina-gpt/trust)** ·
machine-readable at <${r.organization.website}/trust.json>

## Contact

${contactBlock()}
`);

/* --------------------------------------------------------- org + repo ----- */

write('org-profile.md', `${GEN_HEADER}

# ${r.organization.legal_name}

**Sovereign AI platform, built and operated in Germany.**

Data is processed in ${r.organization.data_processing_location}.
Compute: ${r.organization.compute_statement}

## Certifications and memberships — held

${heldTable()}

## In progress — not yet held

${pendingSection()}

${fundstelleNote()}

## Security and disclosure

Vulnerability reports: **${r.contact.security_role_address ?? r.contact.security}** ·
policy at <${r.organization.website}/.well-known/security.txt>

## Verify this yourself

Single source of truth, generated and CI-enforced:
**[ina-gpt/trust](https://github.com/ina-gpt/trust)** ·
machine-readable at <${r.organization.website}/trust.json>

## Contact

${contactBlock()}
`);

const isoCert = r.certifications.find((c) => c.id === 'iso-27001');
write('repo-block.md', `${GEN_HEADER}

### Compliance

${r.organization.legal_name} is certified to **${isoCert?.name ?? 'ISO/IEC 27001:2022'}**
by ${isoCert?.issuer ?? '—'} — Reg. No. **${isoCert?.identifier ?? '—'}**, valid
${validity(isoCert ?? ({} as Certification))}.

${fundstelleNote()}

Full register, with an identifier and a primary-source link for every claim:
**[ina-gpt/trust](https://github.com/ina-gpt/trust)** ·
machine-readable at <${r.organization.website}/trust.json>
`);

/* ------------------------------------------------------------ trust.json -- */

/** Stable key order by construction: objects are built in a fixed order. */
const trustJson = {
  $schema: 'https://github.com/ina-gpt/trust/schema/credentials.schema.json',
  generated_from_commit: commitSha(),
  organization: {
    legal_name: r.organization.legal_name,
    platform_name: r.organization.platform_name,
    address: r.organization.address,
    email: r.organization.email,
    phone: r.organization.phone,
    founded: r.organization.founded,
    website: r.organization.website,
    data_processing_location: r.organization.data_processing_location,
    compute_statement: r.organization.compute_statement,
  },
  certifications: r.certifications.map((e) => ({
    id: e.id, name: e.name, status: e.status, issuer: e.issuer,
    ...(e.identifier ? { identifier: e.identifier } : {}),
    ...(e.scope_en ? { scope_en: e.scope_en } : {}),
    ...(e.valid_from ? { valid_from: e.valid_from } : {}),
    ...(e.valid_to ? { valid_to: e.valid_to } : {}),
    ...(e.statement_of_applicability ? { statement_of_applicability: e.statement_of_applicability } : {}),
    ...(e.evidence_url ? { evidence_url: e.evidence_url } : {}),
    ...(e.stage ? { stage: e.stage } : {}),
    ...(e.since ? { since: e.since } : {}),
    ...(e.note ? { note: e.note } : {}),
  })),
  memberships: r.memberships.map((e) => ({
    id: e.id, name: e.name, status: e.status,
    ...(e.identifier ? { identifier: e.identifier } : {}),
    ...(e.category ? { category: e.category } : {}),
    ...(e.since ? { since: e.since } : {}),
    evidence_url: e.evidence_url ?? null,
  })),
  registrations: r.registrations.map((e) => ({
    id: e.id, name: e.name, status: e.status, identifier: e.identifier,
    issuer: e.issuer, evidence_url: e.evidence_url,
  })),
  practices: r.practices.map((p) => ({ id: p.id, title: p.title, body: p.body })),
  contact: {
    security: r.contact.security,
    ...(r.contact.security_role_address ? { security_role_address: r.contact.security_role_address } : {}),
    security_policy_url: r.contact.security_policy_url,
    canonical_url: r.contact.canonical_url,
    preferred_languages: r.contact.preferred_languages,
  },
  // Both locales, because the certifier ships one URL per language and a
  // consumer must be able to pick the one matching the artwork it renders.
  fundstelle: { en: fundstelleUrlFor('en'), de: fundstelleUrlFor('de') },
  marks: r.marks.map((m) => ({
    id: m.id,
    display_name: m.display_name,
    credential_ref: m.credential_ref,
    file: m.file,
    sha256: m.sha256,
    grantor: m.grantor,
    permission_date: m.permission_date,
    source_url: m.source_url,
    surfaces: m.surfaces,
  })),
};
write('trust.json', JSON.stringify(trustJson, null, 2));


/* ------------------------------------------------------------- marks.json -- */
/**
 * The footer's contract.
 *
 * Only marks whose credential_ref is HELD and whose surfaces include
 * site_footer. That filter is the whole point: removing a credential from the
 * register, or downgrading it from held, removes its mark from the site on the
 * next deploy with no code change — which is what stops the footer and the
 * register from ever disagreeing again.
 *
 * Rendering hints travel with each mark because the permission constrains them.
 * A consumer that recolours or distorts a mark breaches the licence, so the
 * constraint is data, not a comment in a component nobody reads.
 */
const heldIds = new Set([
  ...r.certifications.filter((c) => c.status === 'held').map((c) => c.id),
  ...r.memberships.filter((m) => m.status === 'held').map((m) => m.id),
  ...r.registrations.filter((x) => x.status === 'held').map((x) => x.id),
]);

const footerMarks = r.marks
  .filter((m) => m.surfaces.includes('site_footer'))
  .filter((m) => heldIds.has(m.credential_ref));

const credentialFor = (id: string) =>
  r.certifications.find((c) => c.id === id) ?? r.memberships.find((m) => m.id === id);

write('marks.json', JSON.stringify({
  $comment: 'GENERATED from data/credentials.yaml. Do not edit. Only marks whose credential is HELD appear here.',
  generated_from_commit: commitSha(),
  fundstelle: { en: fundstelleUrlFor('en'), de: fundstelleUrlFor('de') },
  // The sizing POLICY travels with the marks. The app must not re-declare this
  // formula: a formula duplicated across two repositories is a formula that
  // will eventually disagree, and when the renderer and the resolution gate
  // disagree the gate does not go red — it goes WRONG.
  render_policy: r.mark_render_policy ?? null,
  marks: footerMarks.map((m) => {
    const cred = credentialFor(m.credential_ref);
    const isCertMark = r.certifications.some((c) => c.id === m.credential_ref);
    const localeMatch = /-(en|de)$/.exec(m.id)?.[1] as 'en' | 'de' | undefined;
    return {
      id: m.id,
      file: m.file,
      site_path: m.site_path ?? null,
      alt: m.display_name,
      credential_ref: m.credential_ref,
      credential_name: cred?.name ?? m.credential_ref,
      // Measured render geometry, attested here against the sha256 above and
      // RE-MEASURED from the actual bytes by the app's membership-logos gate.
      render: m.render ?? null,
      // For a CERTIFICATION mark the link must go to the Fundstelle for the
      // mark's own locale — the same address the artwork is printed with.
      // Taking the credential's single evidence_url sent the German badge to
      // the English URL, which is the mismatch this whole phase started from.
      target_url: isCertMark
        ? fundstelleUrlFor(localeMatch ?? 'en')
        : ((cred as { evidence_url?: string } | undefined)?.evidence_url ?? m.source_url),
      locale: localeMatch ?? null,
      // Where the mark IS the certification mark, the Fundstelle must appear
      // beside it as a real anchor — text inside the artwork does not satisfy
      // the reference duty.
      fundstelle_required: Boolean(isCertMark),
      fundstelle_url: isCertMark ? fundstelleUrlFor(localeMatch ?? 'en') : null,
      rendering: {
        no_recolour: true,
        preserve_aspect_ratio: true,
        constraints: m.usage_constraints,
      },
    };
  }),
}, null, 2));


/* ----------------------------------------------------------- sources.json -- */
/**
 * The site's PUBLIC provenance file, generated from the same register.
 *
 * public/badges/SOURCES.json is served at inagpt.com/badges/SOURCES.json and is
 * what the site's own membership-logos gate checks a displayed mark against.
 * It was maintained by hand, which made it a THIRD register — and it promptly
 * disagreed: it carried an entry for one mark while the trust register carried
 * four. Generating it from `marks:` is the same fix applied to the footer.
 *
 * LICENCE FACTS ONLY. `grantor` here is an organisation; the individual who
 * signed stays in the private register. The site's gate independently fails if
 * a person's name or an email address appears in any publicly served
 * provenance file, so this generator must never widen what it emits.
 */
write('sources.json', JSON.stringify({
  _README: [
    'GENERATED from ina-gpt/trust data/credentials.yaml. Do not edit.',
    'Provenance and licence register for the third-party marks displayed on inagpt.com.',
    'Served publicly at https://inagpt.com/badges/SOURCES.json, so it carries ONLY',
    'licence facts fit to publish: never a natural person name, job title or email.',
    'Who signed a permission is personal data with no lawful basis for publication;',
    'that evidence lives in the private brand-mark register.',
  ],
  ...Object.fromEntries(footerMarks.map((m) => {
    const base = m.site_path ? m.site_path.split('/').pop()! : m.file.split('/').pop()!;
    return [base, {
      organisation: m.grantor,
      source_url: m.source_url,
      sha256: m.sha256,
      permission: `${m.permission_evidence} Granted ${m.permission_date}.`,
      permission_date: m.permission_date,
      usage_rules: m.usage_constraints,
      credential_ref: m.credential_ref,
    }];
  })),
}, null, 2));

/* ---------------------------------------------------------- security.txt -- */

const expires = addDaysUTC(todayUTC(), 365);
const c = r.contact;
write('security.txt', [
  `# ${r.organization.platform_name} security policy — ${r.organization.legal_name}`,
  `# ${r.organization.website}`,
  '',
  ...(c.security_role_address ? [`Contact: mailto:${c.security_role_address}`] : []),
  `Contact: mailto:${c.security}`,
  `Expires: ${expires}T00:00:00Z`,
  `Preferred-Languages: ${c.preferred_languages}`,
  `Canonical: ${c.canonical_url}`,
  `Policy: ${c.security_policy_url}`,
  ...(c.acknowledgments_url ? [`Acknowledgments: ${c.acknowledgments_url}`] : []),
  ...(c.hiring_url ? [`Hiring: ${c.hiring_url}`] : []),
].join('\n'));

process.stdout.write(
  `generate: wrote 9 file(s) to build/ — ` +
    `${r.certifications.filter((x) => x.status === 'held').length + r.memberships.filter((x) => x.status === 'held').length + r.registrations.filter((x) => x.status === 'held').length} held, ` +
    `${r.certifications.filter((x) => x.status !== 'held').length + r.memberships.filter((x) => x.status !== 'held').length} not held\n`
);
