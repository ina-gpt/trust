# INA GPT GmbH — trust surface.
#
# `make check` is the gate CI runs and the one a reader can run from a clean
# clone. It is deliberately the same command in both places: a CI-only check
# drifts from what a contributor can reproduce, and then nobody reproduces it.

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := check

NPX := npx --no-install

.PHONY: trust check drift validate guard generate links negative fixtures denylist clean

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
## It compares the committed build/ against a fresh render. security.txt is
## excluded from the byte comparison because its Expires field is intentionally
## a function of today; its OTHER lines are compared.
drift:
	@tmp=$$(mktemp -d); \
	cp -a build/. $$tmp/; \
	$(NPX) tsx scripts/generate.ts >/dev/null; \
	rc=0; \
	for f in README.md COMPLIANCE.md SECURITY.md org-profile.md repo-block.md trust.json; do \
	  if ! diff -q "$$tmp/$$f" "build/$$f" >/dev/null 2>&1; then \
	    echo "drift: $$f differs from a fresh render"; rc=1; \
	  fi; \
	done; \
	if ! diff <(grep -v '^Expires:' $$tmp/security.txt) <(grep -v '^Expires:' build/security.txt) >/dev/null 2>&1; then \
	  echo "drift: security.txt differs from a fresh render (ignoring Expires)"; rc=1; \
	fi; \
	rm -rf $$tmp; \
	if [ $$rc -ne 0 ]; then \
	  echo "drift: FAIL — build/ is not what data/credentials.yaml renders. Run 'make trust' and commit."; \
	  exit 1; \
	fi; \
	echo "drift: OK — committed build/ is byte-identical to a fresh render"

links:
	@$(NPX) tsx scripts/check-links.ts

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
