/**
 * Shared types and loading for the trust register.
 *
 * Deliberately tiny. The register is small enough that a schema validator and a
 * YAML parser are the only non-trivial dependencies worth taking; everything
 * else here is the standard library, so the supply chain of a page that makes
 * legal claims stays inspectable by reading it.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_PATH = resolve(REPO, 'data/credentials.yaml');
export const SCHEMA_PATH = resolve(REPO, 'schema/credentials.schema.json');
export const BUILD_DIR = resolve(REPO, 'build');

export const FUNDSTELLE_URL = 'https://www.tuvsud.com/ms-zert';

export type Status = 'held' | 'in_progress' | 'applied' | 'verification_pending';

export interface Organization {
  legal_name: string;
  platform_name: string;
  address: string;
  email: string;
  phone: string;
  founded: string;
  website: string;
  data_processing_location: string;
  compute_statement: string;
}

export interface Registration {
  machine_checkable?: boolean;
  machine_checkable_reason?: string;
  last_human_verified?: string;
  human_verified_by?: string;
  id: string;
  name: string;
  identifier: string;
  issuer: string;
  evidence_url: string;
  status: Status;
}

export interface Certification {
  id: string;
  name: string;
  status: Status;
  issuer: string;
  identifier?: string;
  scope_en?: string;
  scope_de?: string;
  valid_from?: string;
  valid_to?: string;
  statement_of_applicability?: string;
  evidence_url?: string;
  fundstelle_required?: boolean;
  /** Per-locale Fundstelle. The certifier's artwork carries a different URL per language. */
  fundstelle_url?: { en: string; de: string };
  machine_checkable?: boolean;
  machine_checkable_reason?: string;
  last_human_verified?: string;
  human_verified_by?: string;
  stage?: string;
  since?: string;
  declared_roles?: string;
  note?: string;
}

export interface Membership {
  machine_checkable?: boolean;
  machine_checkable_reason?: string;
  last_human_verified?: string;
  human_verified_by?: string;
  id: string;
  name: string;
  status: Status;
  identifier?: string;
  category?: string;
  since?: string;
  evidence_url?: string | null;
  logo?: string;
  reason?: string;
  detail?: string;
}

export interface Mark {
  id: string;
  display_name: string;
  credential_ref: string;
  file: string;
  sha256: string;
  grantor: string;
  grantor_role: string;
  permission_date: string;
  permission_evidence: string;
  source_url: string;
  usage_constraints: string;
  surfaces: Array<'site_footer' | 'trust_repo' | 'org_profile'>;
  /**
   * The public URL path this mark is served at on inagpt.com.
   *
   * Separate from `file` because the two trees name the same artwork
   * differently: the trust repository keeps it under logos/, the site serves it
   * from /badges/. Deriving one from the other by string surgery would break
   * the first time either tree reorganised.
   */
  site_path?: string;
}

export interface Practice {
  id: string;
  title: string;
  body: string;
}

export interface Contact {
  security: string;
  security_role_address?: string;
  security_policy_url: string;
  acknowledgments_url?: string;
  hiring_url?: string;
  canonical_url: string;
  preferred_languages: string;
}

export interface Register {
  organization: Organization;
  registrations: Registration[];
  certifications: Certification[];
  memberships: Membership[];
  practices: Practice[];
  marks: Mark[];
  contact: Contact;
}

export function loadRegister(path: string = DATA_PATH): Register {
  if (!existsSync(path)) fail(`data file not found: ${path}`);
  return parse(readFileSync(path, 'utf8')) as Register;
}

/** Round-trip a register through YAML — used by the V9 determinism self-check. */
export function roundTrip(r: Register): Register {
  return parse(stringify(r)) as Register;
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function fail(msg: string): never {
  process.stderr.write(`FATAL ${msg}\n`);
  process.exit(2);
}

/** Today in UTC, date-only. Every date comparison in this repo uses this. */
export function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

export function daysBetween(fromISO: string, toISO: string): number {
  const a = Date.parse(`${fromISO}T00:00:00Z`);
  const b = Date.parse(`${toISO}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export function addDaysUTC(iso: string, days: number): string {
  const t = Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Everything with status held, across all three credential families. */
export function heldEntries(r: Register): Array<{ kind: string; entry: Registration | Certification | Membership }> {
  const out: Array<{ kind: string; entry: Registration | Certification | Membership }> = [];
  for (const e of r.certifications) if (e.status === 'held') out.push({ kind: 'certifications', entry: e });
  for (const e of r.memberships) if (e.status === 'held') out.push({ kind: 'memberships', entry: e });
  for (const e of r.registrations) if (e.status === 'held') out.push({ kind: 'registrations', entry: e });
  return out;
}

/** Everything NOT held — rendered without a badge, with its date. */
export function pendingEntries(r: Register): Array<{ kind: string; entry: Certification | Membership }> {
  const out: Array<{ kind: string; entry: Certification | Membership }> = [];
  for (const e of r.certifications) if (e.status !== 'held') out.push({ kind: 'certifications', entry: e });
  for (const e of r.memberships) if (e.status !== 'held') out.push({ kind: 'memberships', entry: e });
  return out;
}

export const STATUS_LABEL: Record<Status, string> = {
  held: 'Held',
  in_progress: 'In progress',
  applied: 'Applied',
  verification_pending: 'Verification pending',
};
