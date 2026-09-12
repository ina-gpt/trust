# Third-party mark permissions — public record

Every file in `logos/` is a third-party mark displayed by permission. This file
records the licence FACT for each one. A mark without a block here does not ship:
`scripts/validate.ts` (V6) fails the build if a `logo:` field in the register
points at a file with no permission block, a missing field, or a digest that does
not match the bytes on disk.

## Why this record names an organisation and not a person

The person who grants a logo permission is an employee of another organisation.
Their name, job title and work address are personal data, and publishing them on
our own compliance page has no lawful basis under Art. 6(1) GDPR — the permission
is evidence for us and for an auditor, not for the open internet.

So this public record carries the granting **organisation** and the date. The
individual's identity, the message it arrived in, and the mailbox it sits in are
recorded in the internal evidence register, which is not web-served and not in
this repository.

This is a deliberate divergence from the written specification for this file,
which asked for a `grantor` field. Rule R8 — no private personal data in any
public file — outranks it. A rule that required a GDPR breach in order to satisfy
a field list would be the wrong rule, and satisfying it literally would have made
this repository the thing it exists to prevent.

## Adding a mark

1. Obtain written permission to display the mark. Keep the message.
2. Download the mark from the organisation's own communication-materials page —
   never from a search result, never recoloured or recropped.
3. Add a block below with all four fields.
4. Add the `logo:` field to the entry in `data/credentials.yaml`.
5. Run `make check`. V6 fails until the digest matches.

---

## logos/adra-logotype.png

grantor_organisation: Adra — AI, Data and Robotics Association AISBL
permission_date: 2026-09-10
source_url: https://adr-association.eu/sites/default/files/2024-07/RGB_Adra-logotype_CoL_1.png
sha256: 227d5dc739473f8649ee0d16ede2ba165870bc25fbb8aa9f9705e233c7b46600

- Source page: https://adr-association.eu/communication-materials
- Variant: RGB colour-on-light logotype, transparent background, 500×300
- Membership approved: 2026-09-10
- Permission: written permission to display the logo, granted by the Adra
  Association membership office. Evidence held in the internal register.
- Usage rules: use as delivered. No recolour, distortion or crop. Preserve
  aspect ratio and clear space. Maximum rendered width 250 CSS px.

---

## Marks deliberately NOT shipped

**Gaia-X.** The membership is real and is listed in the Gaia-X member directory
(the register links to it, and the register's `gaia-x` entry is `held` on the
strength of that directory listing). What does not exist is a written logo-use
permission on file. The specification for the register listed a
`logos/gaia-x-members.svg` field; it was **removed** rather than satisfied,
because the alternative was to write a permission record for a permission nobody
has. A mark shipped on an invented record is the precise failure V6 exists to
catch, and inventing one to make V6 green would have been worse than shipping no
logo at all.

To close it: obtain the permission, download the mark from the association's own
materials page, add a block above, add the `logo:` field back to the register.
