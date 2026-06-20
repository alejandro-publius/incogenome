.PHONY: install proxy web all clean smoketest test pgx-test

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

smoketest:
	@bash scripts/smoketest.sh

test: pgx-test
	@echo
	@echo "Run 'make smoketest' separately while 'make proxy' is up."

clean:
	find . -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null || true
	find . -name '*.pyc' -delete 2>/dev/null || true
