SHELL := /bin/bash
WORKER_ENV      := worker/.env
WORKER_SRC      := worker/Cargo.toml
WORKER_BIN_SRC  := worker/target/release/auditable-voting-worker
WORKER_BIN_DST  := /usr/local/bin/auditable-voting-worker
SYSTEMD_UNIT    := worker/contrib/systemd/auditable-voting-worker.service
SYSTEMD_DST     := /etc/systemd/system/auditable-voting-worker.service
SYSTEMD_ENV_DST := /etc/auditable-voting-worker/env
STATE_DIR       := /var/lib/auditable-voting-worker
SERVICE_NAME    := auditable-voting-worker

.PHONY: help \
       install dev build preview \
       test test-watch test-rust test-relay-load test-course-feedback-preflight verify \
       build-worker install-worker uninstall-worker \
       start-worker stop-worker restart-worker worker-status worker-logs

help:
	@echo ""
	@echo "  Web app:"
	@echo "    make install                        Install web dependencies"
	@echo "    make dev                            Start dev server (127.0.0.1:5173)"
	@echo "    make build                          Production build"
	@echo "    make preview                        Preview production build"
	@echo ""
	@echo "  Web tests:"
	@echo "    make test                           Run vitest"
	@echo "    make test-watch                     Run vitest in watch mode"
	@echo "    make test-rust                      Run Rust core tests"
	@echo "    make test-relay-load                Relay load test"
	@echo "    make test-course-feedback-preflight  Course feedback preflight tests"
	@echo "    make verify                         Verify simple blind shares"
	@echo ""
	@echo "  Worker (audit proxy):"
	@echo "    make build-worker                   Build worker binary (release)"
	@echo "    make install-worker                 Build + install service + start"
	@echo "    make uninstall-worker               Stop + remove service and state"
	@echo "    make start-worker                   systemctl start"
	@echo "    make stop-worker                    systemctl stop"
	@echo "    make restart-worker                 systemctl restart"
	@echo "    make worker-status                  Service status + recent logs"
	@echo "    make worker-logs                    Tail service logs"
	@echo ""

install:
	npm --prefix web install

dev:
	npm --prefix web run dev -- --host 127.0.0.1 --port 5173

build:
	npm --prefix web run build

preview:
	npm --prefix web run preview

test:
	cd web && npx vitest run

test-watch:
	cd web && npx vitest

test-rust:
	cargo test --manifest-path auditable-voting-core/Cargo.toml

test-relay-load:
	cd web && npx vitest run src/simpleRelayLoad.test.ts

test-course-feedback-preflight:
	cd web && npx vitest run src/questionnaireProtocol.test.ts src/questionnaireRuntime.test.ts src/questionnaireResponderIdentity.test.ts src/questionnaireTransport.test.ts src/questionnaireCourseFeedbackPreflight.test.ts

verify:
	cd web && npx tsx scripts/verify-simple-blind-shares.ts

build-worker:
	cargo build --release --manifest-path $(WORKER_SRC)

install-worker: build-worker
	@test -f $(WORKER_ENV) || { echo "Error: $(WORKER_ENV) not found. Copy worker/.env.example to $(WORKER_ENV) and fill in values."; exit 1; }
	@grep -qE '^WORKER_NSEC=nsec1\.\.\.' $(WORKER_ENV) && { echo "Error: WORKER_NSEC in $(WORKER_ENV) is still the placeholder value."; exit 1; } || true
	@grep -qE '^COORDINATOR_NPUB=npub1\.\.\.' $(WORKER_ENV) && { echo "Error: COORDINATOR_NPUB in $(WORKER_ENV) is still the placeholder value."; exit 1; } || true
	install -m 755 $(WORKER_BIN_SRC) $(WORKER_BIN_DST)
	mkdir -p $(dir $(SYSTEMD_ENV_DST))
	install -m 600 $(WORKER_ENV) $(SYSTEMD_ENV_DST)
	mkdir -p $(STATE_DIR)
	install -m 644 $(SYSTEMD_UNIT) $(SYSTEMD_DST)
	systemctl daemon-reload
	systemctl enable $(SERVICE_NAME)
	@echo ""
	@echo "Worker installed. Starting service..."
	systemctl start $(SERVICE_NAME)
	@echo ""
	@echo "Run 'make worker-status' to check."

uninstall-worker:
	systemctl stop $(SERVICE_NAME) 2>/dev/null || true
	systemctl disable $(SERVICE_NAME) 2>/dev/null || true
	rm -f $(SYSTEMD_DST) $(WORKER_BIN_DST) $(SYSTEMD_ENV_DST)
	systemctl daemon-reload
	@echo ""
	@read -p "Remove state directory $(STATE_DIR)? [y/N] " confirm && [ "$$confirm" = "y" ] && rm -rf $(STATE_DIR) || echo "State directory kept."

start-worker:
	systemctl start $(SERVICE_NAME)

stop-worker:
	systemctl stop $(SERVICE_NAME)

restart-worker:
	systemctl restart $(SERVICE_NAME)

worker-status:
	systemctl status $(SERVICE_NAME) --no-pager -l; \
	echo ""; \
	echo "--- recent logs ---"; \
	journalctl -u $(SERVICE_NAME) -n 20 --no-pager

worker-logs:
	journalctl -u $(SERVICE_NAME) -f
