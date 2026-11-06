.PHONY: setup lint typecheck test check audit

setup:
	bash scripts/setup.sh

lint:
	npm run lint

typecheck:
	npm run typecheck

test:
	npm test

check: lint typecheck test

audit:
	bash scripts/security-scan.sh
