# INA GPT GmbH — trust surface.
#
# `make check` is the gate CI runs and the one a reader can run from a clean
# clone. It is deliberately the same command in both places: a CI-only check
# drifts from what a contributor can reproduce, and then nobody reproduces it.

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := check

NPX := npx --no-install

.PHONY: trust check drift validate guard generate links negative fixtures denylist verify install-site clean

## validate + guard + generate — the normal local loop
trust: generate validate guard

validate:
	@$(NPX) tsx scripts/validate.ts

guard:
	@$(NPX) tsx scripts/guard.ts

generate:
	@$(NPX) tsx scripts/generate.ts

## every gate, plus proof that the committed output matches a fresh render
check: trust drift
	@echo "check: OK — schema, rules, disclosure guard and drift all green"

## The drift check is what makes "generated" a fact rather than a claim.
##
## IT COMPARES THE COMMITTED build/ AGAINST A FRESH RENDER — via `git show`,
## not via the working tree. The first version of this target compared the
## working tree after `make trust` had already regenerated it, so it compared a
## fresh render against a fresh render and could never fail. It was a decorative
## gate, and it passed in CI for exactly that reason.
##
## Two fields are excluded from the byte comparison because they are MEANT to
## vary, and both are excluded by name rather than by fuzzing the whole file:
##   security.txt Expires            a function of today (RFC 9116 requires it)
##   trust.json generated_from_commit
##                                   the publishing commit, which cannot equal
##                                   the commit that contains it — the value is
##                                   set at publish time from GITHUB_SHA.
drift:
	@fresh=$$(mktemp -d); committed=$$(mktemp -d); rc=0; \
	cp -a build/. $$committed/ 2>/dev/null || true; \
	for f in README.md COMPLIANCE.md SECURITY.md org-profile.md repo-block.md trust.json security.txt; do \
	  if git cat-file -e HEAD:build/$$f 2>/dev/null; then \
	    git show HEAD:build/$$f > $$committed/$$f; \
	  else \
	    echo "drift: build/$$f is not committed yet"; rc=1; \
	  fi; \
	done; \
	$(NPX) tsx scripts/generate.ts >/dev/null; \
	cp -a build/. $$fresh/; \
	for f in README.md COMPLIANCE.md SECURITY.md org-profile.md repo-block.md; do \
	  if ! diff -q "$$committed/$$f" "$$fresh/$$f" >/dev/null 2>&1; then \
	    echo "drift: build/$$f differs from a fresh render of data/credentials.yaml"; rc=1; \
	  fi; \
	done; \
	if ! diff <(grep -v '"generated_from_commit"' $$committed/trust.json) \
	          <(grep -v '"generated_from_commit"' $$fresh/trust.json) >/dev/null 2>&1; then \
	  echo "drift: build/trust.json differs from a fresh render (ignoring generated_from_commit)"; rc=1; \
	fi; \
	if ! diff <(grep -v '^Expires:' $$committed/security.txt) \
	          <(grep -v '^Expires:' $$fresh/security.txt) >/dev/null 2>&1; then \
	  echo "drift: build/security.txt differs from a fresh render (ignoring Expires)"; rc=1; \
	fi; \
	rm -rf $$fresh $$committed; \
	if [ $$rc -ne 0 ]; then \
	  echo "drift: FAIL — the committed build/ is not what data/credentials.yaml renders. Run 'make trust' and commit."; \
	  exit 1; \
	fi; \
	echo "drift: OK — the COMMITTED build/ is byte-identical to a fresh render"

links:
	@$(NPX) tsx scripts/check-links.ts

## Independent audit: fetch the PUBLISHED surfaces and assert the claims.
## Deliberately does not read build/ — that would only prove the generator
## agrees with itself.
verify:
	@$(NPX) tsx scripts/verify-published.ts

install-site:
	@bash scripts/install-site.sh

fixtures:
	@$(NPX) tsx scripts/make-fixtures.ts

negative: fixtures
	@$(NPX) tsx scripts/negative.ts

## Regenerate the HMAC digest set from the PRIVATE plaintext denylist.
## DENYLIST must point outside this repository.
denylist:
	@test -n "$$DENYLIST" || { echo "set DENYLIST=<path to the private plaintext list>"; exit 2; }
	@$(NPX) tsx scripts/build-denylist.ts --in=$$DENYLIST

clean:
	@rm -rf build && mkdir -p build
