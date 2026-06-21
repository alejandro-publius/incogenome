.PHONY: install proxy web all clean smoketest test pgx-test parser-test getrm agent-test pgxqa-test lit-test mock-patients benchmark

install:
	cd server && pip install -r requirements.txt

proxy:
	cd server && uvicorn proxy:app --reload --port 8001

web:
	python3 -m http.server 8000

all:
	@echo "Run in two terminals:"
	@echo "  make proxy   # http://localhost:8001"
	@echo "  make web     # http://localhost:8000/"

pgx-test:
	@node tests/pgx.test.mjs

parser-test:
	@node tests/parser.test.mjs

getrm:
	@node tests/getrm.test.mjs

agent-test:
	@node tests/agent.test.mjs

pgxqa-test:
	@node tests/pgxqa.test.mjs

lit-test:
	@node tests/literature-grounded.test.mjs

mock-patients:
	@node tests/mock-patients.test.mjs

benchmark:
	@node tests/patient-benchmark.test.mjs

smoketest:
	@bash scripts/smoketest.sh

test: pgx-test
	@echo
	@echo "Run 'make smoketest' separately while 'make proxy' is up."
	@echo "Run 'make getrm' separately for CDC GeT-RM known-answer fixtures."

clean:
	find . -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null || true
	find . -name '*.pyc' -delete 2>/dev/null || true
