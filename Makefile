# sakuda — task runner. Every port/secret comes from .env (copy .env.example).
#
# Precedence: CLI (`make up SAKUDA_PORT=3005`) > .env > defaults below.

-include .env
export

SAKUDA_PORT    ?= 3001
SAKUDA_BIND    ?= 127.0.0.1
JUICESHOP_PORT ?= 4001
# Auth capture (#17): DevTools port of the host Chrome that sakuda drives.
# Each launch gets a fresh throwaway profile (Chrome refuses remote debugging
# on the default one), so your everyday logins stay out of reach and no
# captured session lingers on disk; sakuda quits that Chrome after a capture.
CAPTURE_CDP_PORT ?= 9222
COMPOSE        ?= docker compose
# Juice Shop is its own compose project (targets/juice-shop/compose.yml), so
# sakuda's down/reset never touch it. Compose looks for .env next to the
# compose file, so point it at the root .env explicitly (when one exists —
# the defaults above cover a checkout without it).
JUICE_COMPOSE  ?= $(COMPOSE) $(if $(wildcard .env),--env-file .env) -f targets/juice-shop/compose.yml

.DEFAULT_GOAL := help
.PHONY: help env keygen build up down restart logs ps open capture-browser juice-up juice-down juice-seed \
        dev test e2e lint typecheck check clean reset-data

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | sort | \
	  awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "  ports: sakuda http://localhost:$(SAKUDA_PORT)  juice-shop http://localhost:$(JUICESHOP_PORT)  (bind $(SAKUDA_BIND))"

## ---- setup ---------------------------------------------------------------

env: ## Create .env from .env.example (keeps an existing .env) and fill the encryption key
	@if [ -f .env ]; then echo ".env exists — leaving it alone"; else \
	  cp .env.example .env; \
	  key="$$(pnpm -s keygen)"; \
	  sed -i '' "s|^SAKUDA_ENCRYPTION_KEY=.*|SAKUDA_ENCRYPTION_KEY=$$key|" .env; \
	  echo "wrote .env with a fresh SAKUDA_ENCRYPTION_KEY — keep it safe"; fi

keygen: ## Print a new SAKUDA_ENCRYPTION_KEY
	@pnpm -s keygen

## ---- docker (production-like, one container) -----------------------------

build: ## Build the sakuda image (ZAP + nuclei + templates + app)
	$(COMPOSE) build --no-cache sakuda

up: ## Start sakuda in the background (http://localhost:SAKUDA_PORT)
	$(COMPOSE) up -d sakuda
	@echo "sakuda: http://localhost:$(SAKUDA_PORT)"

down: ## Stop and remove the sakuda container (data volume kept; Juice Shop untouched)
	$(COMPOSE) down

restart: ## Restart sakuda
	$(COMPOSE) restart sakuda

logs: ## Follow sakuda logs
	$(COMPOSE) logs -f sakuda

ps: ## Show container status (sakuda, then Juice Shop)
	$(COMPOSE) ps
	@$(JUICE_COMPOSE) ps

open: ## Open the UI in the browser
	open "http://localhost:$(SAKUDA_PORT)"

capture-browser: ## Start a Chrome that sakuda can drive for "Log in with browser" (Edit site → Authentication)
	@profile="$$(mktemp -d "$${TMPDIR:-/tmp}/sakuda-capture.XXXXXX")"; \
	if [ "$$(uname)" = Darwin ]; then \
	  open -na "Google Chrome" --args --remote-debugging-port=$(CAPTURE_CDP_PORT) \
	    --user-data-dir="$$profile" --no-first-run about:blank; \
	else \
	  bin="$$(command -v google-chrome || command -v chromium || command -v chromium-browser)"; \
	  [ -n "$$bin" ] || { echo "Chrome/Chromium not found"; exit 1; }; \
	  nohup "$$bin" --remote-debugging-port=$(CAPTURE_CDP_PORT) --user-data-dir="$$profile" \
	    --no-first-run about:blank >/dev/null 2>&1 & \
	fi; \
	echo "capture browser: DevTools on 127.0.0.1:$(CAPTURE_CDP_PORT), throwaway profile $$profile"; \
	echo "anything on this machine can drive it while it runs — sakuda quits it after Capture; quit it yourself if you stop early"

juice-up: ## Start OWASP Juice Shop as a dry-run target (http://localhost:JUICESHOP_PORT)
	$(JUICE_COMPOSE) up -d
	@echo "juice-shop: http://localhost:$(JUICESHOP_PORT)  → make juice-seed registers it in sakuda as a ready-to-scan site"

juice-seed: ## Register Juice Shop in sakuda as a logged-in demo site (needs make up + make juice-up; re-run refreshes the token)
	pnpm -s seed:juice

juice-down: ## Stop and remove Juice Shop (its accounts reset on the next start; run make juice-seed again after juice-up)
	$(JUICE_COMPOSE) down

## ---- local development (native nuclei, ZAP via scripts/zap-docker.sh) ----

dev: ## Run the Nuxt dev server on SAKUDA_PORT
	pnpm dev --port $(SAKUDA_PORT)

test: ## Unit + component tests
	pnpm test

e2e: ## API e2e tests
	pnpm test:e2e

lint: ## ESLint + Prettier check
	pnpm lint

typecheck: ## nuxt typecheck
	pnpm run typecheck

check: lint typecheck test ## Everything CI runs

## ---- cleanup -------------------------------------------------------------

clean: ## Remove local build output and dev scan data (./data, .output, .nuxt)
	rm -rf data .output .nuxt

reset-data: ## DESTRUCTIVE: delete the docker data volume (sites, scans, encrypted headers). Requires CONFIRM=1
	@if [ "$(CONFIRM)" != "1" ]; then echo "refusing: run 'make reset-data CONFIRM=1' to delete the sakuda-data volume"; exit 1; fi
	$(COMPOSE) down -v
