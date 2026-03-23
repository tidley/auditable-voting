VENV_PYTHON := .venv/bin/python3
PYTEST := $(VENV_PYTHON) -m pytest
TESTS_DIR := tests
ANSIBLE := ansible-playbook

.PHONY: help deploy deploy-client deploy-coordinator init-election join-election test test-fast test-all test-ui deploy-and-test deploy-and-test-all

help:
	@echo ""
	@echo "  Deploy targets:"
	@echo "    make deploy              Full stack + election (deploy-and-prepare.yml)"
	@echo "    make deploy-client       Frontend only (deploy-voting-client.yml)"
	@echo "    make deploy-coordinator  Coordinator only (deploy-coordinator.yml)"
	@echo ""
	@echo "  Election targets (multi-coordinator):"
	@echo "    make init-election       Create a new election (38008 + 38007 + 38009 + 38012)"
	@echo "    make join-election       Join an existing election (38007 + 38009 + 38012)"
	@echo ""
	@echo "  Test targets (sequential, stop on failure):"
	@echo "    make test                Fast + integration (default, no VPS needed)"
	@echo "    make test-fast           Fast unit tests only"
	@echo "    make test-all            Fast + integration + UI Playwright (requires VPS)"
	@echo "    make test-ui             UI Playwright only (requires VPS)"
	@echo ""
	@echo "  Combined:"
	@echo "    make deploy-and-test     Deploy, then test (fast + integration)"
	@echo "    make deploy-and-test-all Deploy, then test-all (includes UI Playwright)"
	@echo ""
	@echo "  Pre-commit hook tiers (set before git commit):"
	@echo "    RUN_FAST_ONLY=1 git commit ...   Fast only"
	@echo "    RUN_ALL_TESTS=1 git commit ...   All tiers"
	@echo "    SKIP_TESTS=1 git commit ...      Skip tests"
	@echo ""

# ─── Deploy ──────────────────────────────────────────────────────────────────

deploy:
	$(ANSIBLE) ansible/playbooks/deploy-and-prepare.yml

deploy-client:
	$(ANSIBLE) ansible/playbooks/deploy-voting-client.yml

deploy-coordinator:
	$(ANSIBLE) ansible/playbooks/deploy-coordinator.yml

# ─── Election (Multi-Coordinator) ────────────────────────────────────────────

init-election:
	$(ANSIBLE) ansible/playbooks/init-election.yml

join-election:
	$(ANSIBLE) ansible/playbooks/join-election.yml

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

# ─── Combined ────────────────────────────────────────────────────────────────

deploy-and-test: deploy test

deploy-and-test-all: deploy test-all
