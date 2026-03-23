# Local Multi-Mint CDK Deployment with gRPC Operator CLI

> **Note:** The event kind specs in `../auditable-voting/docs/` are outdated. The canonical protocol definitions live in this repo: `docs/04-VOTING_EVENT_INTEROP_NOTES.md` and `docs/03-PROTOCOL_REFERENCE.md`.

## 1. Objective

Deploy three independent Cashu CDK mint instances locally using Docker and Ansible, with:

- Manual approval enabled for minting (incoming)
- Manual approval enabled for melting (outgoing)
- Arbitrary melt requests enabled
- Zero melt fee
- gRPC as the operator control plane
- A lightweight Python CLI tool in this repo to manage approvals

No Cloudflare.
No Traefik.
No TLS.
Localhost only.

This architecture will later support a ContextVM policy layer that interacts with the mints over gRPC.

---

## 2. High-Level Architecture

Ansible (localhost target)
        |
        v
Docker Containers (3 total)
  - cashu-mint-mint1 (3338 / 8086)
  - cashu-mint-mint2 (3339 / 8087)
  - cashu-mint-mint3 (3340 / 8088)
        |
        v
gRPC
        |
        v
mintctl (Python Operator CLI)

Each mint is fully isolated.

---

## 3. Mint Deployment Design

### 3.1 Number of Mints

Three separate containers:

| Mint  | HTTP | gRPC | Volume Path     |
|--------|------|------|-----------------|
| mint1 | 3338 | 8086 | ./data/mint1   |
| mint2 | 3339 | 8087 | ./data/mint2   |
| mint3 | 3340 | 8088 | ./data/mint3   |

All bound to 127.0.0.1.

---

### 3.2 Docker Image

Source repository: cdk
Branch: feat/fakewallet-manual-approval

Image name:

    cdk-mint:manual-approval

Built locally by Ansible. All three containers use the same image.

---

### 3.3 Environment Configuration Per Mint

Required environment variables:

    CDK_MINTD_FAKE_WALLET_MANUAL_APPROVAL_INCOMING=true
    CDK_MINTD_FAKE_WALLET_MANUAL_APPROVAL_OUTGOING=true
    CDK_MINTD_FAKE_WALLET_ACCEPT_ARBITRARY_MELT=true
    CDK_MINTD_FAKE_WALLET_ARBITRARY_MELT_FEE=0

    MINT_RPC_SERVER_ENABLE=true
    MINT_RPC_SERVER_PORT=<unique>

    MINT_LISTEN_HOST=0.0.0.0
    MINT_PORT=<unique>

Differences per mint:

- MINT_PORT
- MINT_RPC_SERVER_PORT
- Container name
- Volume path

---

### 3.4 Identity Model

Mint private keys are auto-generated.

Behavior:

- On first container start, if no key exists in the volume, a new key is generated.
- The key is persisted inside the volume.
- Identity remains stable across restarts.

No private keys are stored in Ansible.

---

### 3.5 Restart Policy

Docker restart policy:

    unless-stopped

Ensures automatic restart on crash and on machine reboot. No systemd wrapper required.

---

## 4. Ansible Design

### 4.1 Inventory

Target:

    localhost
    ansible_connection=local

---

### 4.2 Variables

    mints:
      - name: mint1
        http_port: 3338
        grpc_port: 8086
      - name: mint2
        http_port: 3339
        grpc_port: 8087
      - name: mint3
        http_port: 3340
        grpc_port: 8088

---

### 4.3 Role Responsibilities

For each mint:

1. Ensure data directory exists
2. Generate .env file
3. Run Docker container
4. Expose ports
5. Apply restart policy

Skipped components:

- Traefik
- Cloudflare
- DNS
- TLS

---

## 5. gRPC Control Plane

CDK exposes approval functionality via:

- UpdateNut04Quote (mint approval)
- UpdateNut05 (melt approval)
- GetNut04Quote
- GetNut05Quote

Manual approval behavior is triggered by the environment flags listed above.

No custom RPC methods are required.

---

## 6. Operator CLI (mintctl)

Language: Python
Library: grpcio

Purpose: provide a simple operator interface for mint and melt approvals.

---

### 6.1 CLI Responsibilities

List pending mint approvals:

    mintctl --mint mint1 pending-mints

Approve mint:

    mintctl --mint mint1 approve-mint <quote_id>

List pending melts:

    mintctl --mint mint1 pending-melts

Approve melt:

    mintctl --mint mint1 approve-melt <quote_id>

---

### 6.2 Mint Mapping Logic

CLI maintains mapping:

    mint1 -> localhost:8086
    mint2 -> localhost:8087
    mint3 -> localhost:8088

Mapping may later be loaded from YAML or shared Ansible vars.

---

## 7. Testing Checklist

1. Confirm containers running:

       docker ps

2. Create mint quote; state should be pending.

3. List pending mints:

       mintctl --mint mint1 pending-mints

4. Approve mint:

       mintctl --mint mint1 approve-mint <id>

5. Mint succeeds.

6. Create arbitrary melt request (example):

       IBAN:GB29NWBK60161331926819:AMOUNT:1000

7. Melt returns pending.

8. Approve melt:

       mintctl --mint mint1 approve-melt <id>

9. Melt succeeds.

---

## 8. Isolation Guarantees

Each mint container has:

- Separate database
- Separate FakeWallet memory
- Separate invoice queues
- Separate gRPC port
- Separate identity

No cross-mint state contamination.

---

## 9. Future Extension: ContextVM Integration

Planned architecture:

    Nostr User
        |
        v
    ContextVM (policy layer)
        |
        v
    gRPC client
        |
        v
    Mint containers

ContextVM responsibilities:

- Enforce issuance policies
- Limit mint amounts per npub
- Apply melt approval logic
- Provide audit control

Mint remains backend execution engine.

---

## 10. Execution Phases

Phase 1: Implement Docker-based multi-mint deployment

Phase 2: Implement mintctl CLI

Phase 3: Validate approval workflow

Phase 4: Integrate ContextVM

---

## 11. Open Decisions

1. CLI location within repo (scripts/, dedicated package, etc.)
2. Mint-to-port mapping storage strategy
3. Future multi-mint batch approval support

This document defines the execution-ready plan for multi-mint local CDK deployment with gRPC-based operator control and future ContextVM integration.
