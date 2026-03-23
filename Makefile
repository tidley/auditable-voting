VENV_PYTHON := .venv/bin/python3
PYTEST := $(VENV_PYTHON) -m pytest
TESTS_DIR := tests
ANSIBLE := ansible-playbook

-include deploy.env

.PHONY: help deploy deploy-domain deploy-client deploy-coordinator test test-fast test-all test-ui test-domain deploy-and-test deploy-and-test-all deploy-domain-and-test

help:
	@echo ""
	@echo "  Deploy targets:"
	@echo "    make deploy              Full stack + election (HTTP/sslip.io)"
	@echo "    make deploy-domain       Full stack + election (HTTPS/custom domain + Cloudflare)"
	@echo "    make deploy-client       Frontend only (deploy-voting-client.yml)"
	@echo "    make deploy-coordinator  Coordinator only (deploy-coordinator.yml)"
	@echo ""
	@echo "  Test targets (sequential, stop on failure):"
	@echo "    make test                Fast + integration (default, no VPS needed)"
	@echo "    make test-fast           Fast unit tests only"
	@echo "    make test-all            Fast + integration + UI Playwright (requires VPS)"
	@echo "    make test-ui             UI Playwright only (requires VPS)"
	@echo "    make test-domain         HTTPS/domain/TLS tests (after make deploy-domain)"
	@echo ""
	@echo "  Combined:"
	@echo "    make deploy-and-test          Deploy (HTTP), then test"
	@echo "    make deploy-and-test-all      Deploy (HTTP), then test-all"
	@echo "    make deploy-domain-and-test   Deploy (HTTPS), then test"
	@echo ""
	@echo "  Pre-commit hook tiers (set before git commit):"
	@echo "    RUN_FAST_ONLY=1 git commit ...   Fast only"
	@echo "    RUN_ALL_TESTS=1 git commit ...   All tiers"
	@echo "    SKIP_TESTS=1 git commit ...      Skip tests"
	@echo ""
	@echo "  Secrets are read from deploy.env (see deploy.env.example)."
	@echo ""

# ─── Deploy ──────────────────────────────────────────────────────────────────

deploy:
	$(ANSIBLE) ansible/playbooks/deploy-and-prepare.yml \
		--extra-vars "vps_ip=$(VPS_IP) ansible_ssh_private_key_file=$(SSH_KEY_PATH) ansible_user=$(ANSIBLE_USER)"

deploy-domain:
	$(ANSIBLE) ansible/playbooks/deploy-and-prepare.yml \
		--extra-vars "vps_ip=$(VPS_IP) ansible_ssh_private_key_file=$(SSH_KEY_PATH) ansible_user=$(ANSIBLE_USER) tls_enabled=true voting_domain=$(VOTING_DOMAIN) acme_email=$(ACME_EMAIL) acme_env_vars={'CF_API_EMAIL':'$(CF_API_EMAIL)','CF_DNS_API_TOKEN':'$(CF_DNS_API_TOKEN)'}"

deploy-client:
	$(ANSIBLE) ansible/playbooks/deploy-voting-client.yml

deploy-coordinator:
	$(ANSIBLE) ansible/playbooks/deploy-coordinator.yml

# ─── Test ────────────────────────────────────────────────────────────────────

test:
	$(PYTEST) $(TESTS_DIR)/ -v -m "fast or integration" \
		--ignore=$(TESTS_DIR)/test_ui_dashboard.py \
		--ignore=$(TESTS_DIR)/test_ui_issuance.py \
		--ignore=$(TESTS_DIR)/test_ui_voting.py \
		--ignore=$(TESTS_DIR)/test_e2e_voting.py \
		--ignore=$(TESTS_DIR)/test_coordinator_deploy.py \
		--ignore=$(TESTS_DIR)/test_coordinator_e2e.py \
		--ignore=$(TESTS_DIR)/test_coordinator_integration_vps.py \
		--ignore=$(TESTS_DIR)/test_ui_fixes.py \
		--timeout=120

test-fast:
	$(PYTEST) $(TESTS_DIR)/ -v -m fast --timeout=120

test-all: test
	@echo ""
	@echo "=== Tier 3: UI Playwright tests ==="
	RUN_ALL_TESTS=1 $(PYTEST) $(TESTS_DIR)/test_ui_fixes.py $(TESTS_DIR)/test_ui_dashboard.py $(TESTS_DIR)/test_ui_issuance.py $(TESTS_DIR)/test_ui_voting.py -v --timeout=600

test-ui:
	RUN_ALL_TESTS=1 $(PYTEST) $(TESTS_DIR)/test_ui_fixes.py $(TESTS_DIR)/test_ui_dashboard.py $(TESTS_DIR)/test_ui_issuance.py $(TESTS_DIR)/test_ui_voting.py -v --timeout=600

test-domain:
	$(PYTEST) $(TESTS_DIR)/test_domain_deploy.py -v --timeout=30

# ─── Combined ────────────────────────────────────────────────────────────────

deploy-and-test: deploy test

deploy-and-test-all: deploy test-all

deploy-domain-and-test: deploy-domain test-domain
