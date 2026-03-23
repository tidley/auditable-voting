import { useState } from "react";
import { verifyMerkleProof, type MerklePathNode } from "../../src/merkle";
import {
  fetchResult,
  fetchVoteTree,
  fetchInclusionProof,
  type FinalResultInfo,
  type VoteTreeResponse,
  type InclusionProofResponse,
} from "./coordinatorApi";

type Props = {
  ballotEventId?: string;
};

function truncateHash(hash: string, chars = 8): string {
  if (!hash || hash.length <= chars * 2 + 3) return hash;
  return `${hash.slice(0, chars)}...${hash.slice(-chars)}`;
}

function TreeNode({ hash, isHighlighted, isRoot }: { hash: string; isHighlighted?: boolean; isRoot?: boolean }) {
  return (
    <span
      title={hash}
      style={{
        display: "inline-block",
        padding: "2px 6px",
        borderRadius: 4,
        fontSize: "0.72rem",
        fontFamily: "monospace",
        background: isHighlighted ? "rgba(88,59,39,0.15)" : "rgba(88,59,39,0.05)",
        border: isRoot ? "2px solid var(--accent)" : isHighlighted ? "1px solid var(--accent)" : "1px solid rgba(88,59,39,0.1)",
        color: isHighlighted ? "var(--accent)" : "inherit",
        fontWeight: isRoot ? 700 : 400,
        wordBreak: "break-all" as const,
      }}
    >
      {truncateHash(hash)}
    </span>
  );
}

function MerklePathViz({ path, leafHash, root }: { path: MerklePathNode[]; leafHash: string; root: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "center" }}>
      <TreeNode hash={leafHash} isHighlighted />
      {path.map((node, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ color: "var(--muted)", fontSize: "0.7rem" }}>{node.position === "left" ? "\u2190" : "\u2192"}</span>
          <TreeNode hash={node.hash} isHighlighted={i === path.length - 1} />
        </div>
      ))}
      <div style={{ borderTop: "2px solid var(--accent)", width: "100%", margin: "4px 0" }} />
      <TreeNode hash={root} isRoot />
    </div>
  );
}

export default function MerkleTreeViz({ ballotEventId }: Props) {
  const [result, setResult] = useState<FinalResultInfo | null>(null);
  const [tree, setTree] = useState<VoteTreeResponse | null>(null);
  const [proof, setProof] = useState<InclusionProofResponse | null>(null);
  const [verificationStatus, setVerificationStatus] = useState<"idle" | "loading" | "verified" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);

  async function loadAll() {
    setError(null);
    setVerificationStatus("loading");
    try {
      const [r, t] = await Promise.all([fetchResult(), fetchVoteTree()]);
      setResult(r);
      setTree(t);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load tree data");
      setVerificationStatus("idle");
    }
  }

  async function verifyInclusion() {
    if (!ballotEventId) return;
    setVerificationStatus("loading");
    setError(null);
    try {
      const p = await fetchInclusionProof(ballotEventId);
      setProof(p);
      if (!p) {
        setError("Inclusion proof not found. Your vote may not be in the final tally.");
        setVerificationStatus("failed");
        return;
      }

      const valid = verifyMerkleProof(p.leaf_hash, p.merkle_path, p.merkle_root);
      if (valid && result) {
        const rootMatch = p.merkle_root === result.merkle_root;
        setVerificationStatus(rootMatch ? "verified" : "failed");
        if (!rootMatch) setError("Proof root does not match final result root.");
      } else {
        setVerificationStatus("failed");
        setError("Merkle proof verification failed.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Verification failed");
      setVerificationStatus("failed");
    }
  }

  return (
    <section className="content-grid">
      <article className="panel panel-wide">
        <div className="panel-header">
          <div>
            <p className="panel-kicker">Tally &amp; Verification</p>
            <h2>Merkle tree</h2>
          </div>
        </div>

        <div className="button-row" style={{ marginBottom: 12 }}>
          <button className="secondary-button" onClick={() => void loadAll()} disabled={verificationStatus === "loading"}>
            {verificationStatus === "loading" ? "Loading..." : "Load tree data"}
          </button>
          {ballotEventId && (
            <button className="primary-button" onClick={() => void verifyInclusion()} disabled={verificationStatus === "loading"}>
              {verificationStatus === "loading" ? "Verifying..." : "Verify my vote"}
            </button>
          )}
        </div>

        {error && <div className="notice notice-error">{error}</div>}
        {verificationStatus === "verified" && (
          <div className="notice notice-success" style={{ fontSize: "1rem", padding: "12px" }}>
            Vote verified. Your ballot is included in the final tally.
          </div>
        )}

        {result && (
          <div className="detail-stack" style={{ marginBottom: 16 }}>
            <p className="field-hint">Total votes: {result.total_votes} / {result.max_supply}</p>
            <p className="field-hint">Vote merkle root: <code style={{ fontSize: "0.8rem" }}>{result.merkle_root}</code></p>
            <p className="field-hint">Issuance root: <code style={{ fontSize: "0.8rem" }}>{result.issuance_commitment_root}</code></p>
            <p className="field-hint">Spent root: <code style={{ fontSize: "0.8rem" }}>{result.spent_commitment_root}</code></p>
          </div>
        )}

        {tree && tree.leaves.length > 0 && (
          <div>
            <p className="code-label" style={{ marginBottom: 8 }}>Full tree ({tree.total_leaves} leaves)</p>
            <div style={{ overflowX: "auto", padding: "8px 0" }}>
              {[...tree.levels].reverse().map((level, levelIdx) => (
                <div key={levelIdx} style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 4, justifyContent: "center" }}>
                  {level.map((hash, nodeIdx) => {
                    const isLeafLevel = levelIdx === tree.levels.length - 1;
                    const leafEvent = isLeafLevel
                      ? tree.leaves.find(l => l.hash === hash)
                      : null;
                    const isMyVote = Boolean(ballotEventId && leafEvent?.event_id === ballotEventId);
                    return (
                      <div key={nodeIdx} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
                        <TreeNode hash={hash} isHighlighted={isMyVote} isRoot={levelIdx === 0} />
                        {leafEvent && (
                          <span style={{ fontSize: "0.6rem", color: "var(--muted)" }}>
                            {truncateHash(leafEvent.event_id, 6)}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        )}

        {!tree && result === null && verificationStatus === "idle" && (
          <p className="empty-copy">Load tree data to see the Merkle tree and verify your vote inclusion.</p>
        )}

        {proof && (
          <div style={{ marginTop: 16, borderTop: "1px solid rgba(88,59,39,0.08)", paddingTop: 12 }}>
            <p className="code-label" style={{ marginBottom: 8 }}>Your inclusion proof path</p>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              <div>
                <p className="field-hint" style={{ marginBottom: 4 }}>Leaf hash</p>
                <TreeNode hash={proof.leaf_hash} isHighlighted />
              </div>
              <MerklePathViz path={proof.merkle_path} leafHash={proof.leaf_hash} root={proof.merkle_root} />
            </div>
          </div>
        )}
      </article>
    </section>
  );
}
