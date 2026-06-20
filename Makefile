.PHONY: install proxy web all clean smoketest

install:
	cd server && pip install -r requirements.txt

proxy:
	cd server && uvicorn proxy:app --reload --port 8001

web:
	python3 -m http.server 8000

all:
	@echo "Run in two terminals:"
	@echo "  make proxy   # http://localhost:8001"
	@echo "  make web     # http://localhost:8000/dev/test.html"

smoketest:
	@bash scripts/smoketest.sh

clean:
	find . -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null || true
	find . -name '*.pyc' -delete 2>/dev/null || true
