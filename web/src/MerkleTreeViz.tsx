import { useState, useMemo } from "react";
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

async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

type HighlightKind = "none" | "leaf" | "branch" | "sibling";

function TreeNode({ hash, highlight, isRoot }: { hash: string; highlight?: HighlightKind; isRoot?: boolean }) {
  const isLeaf = highlight === "leaf";
  const isBranch = highlight === "branch";
  const isSibling = highlight === "sibling";
  return (
    <span
      title={hash}
      style={{
        display: "inline-block",
        padding: "2px 6px",
        borderRadius: 4,
        fontSize: "0.72rem",
        fontFamily: "monospace",
        background: isLeaf
          ? "rgba(88,59,39,0.18)"
          : isBranch
            ? "rgba(88,59,39,0.10)"
            : isSibling
              ? "rgba(88,59,39,0.06)"
              : "rgba(88,59,39,0.05)",
        border: isRoot
          ? "2px solid var(--accent)"
          : isLeaf
            ? "1px solid var(--accent)"
            : "1px solid rgba(88,59,39,0.1)",
        borderLeft: isBranch
          ? "4px solid var(--accent)"
          : isSibling
            ? "4px dashed rgba(88,59,39,0.35)"
            : undefined,
        color: isLeaf || isBranch
          ? "var(--accent)"
          : isSibling
            ? "rgba(88,59,39,0.7)"
            : "inherit",
        fontWeight: isRoot || isLeaf ? 700 : isBranch ? 600 : 400,
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
      <TreeNode hash={leafHash} highlight="leaf" />
      {path.map((node, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ color: "var(--muted)", fontSize: "0.7rem" }}>{node.position === "left" ? "\u2190" : "\u2192"}</span>
          <TreeNode hash={node.hash} highlight={i === path.length - 1 ? "branch" : "sibling"} />
        </div>
      ))}
      <div style={{ borderTop: "2px solid var(--accent)", width: "100%", margin: "4px 0" }} />
      <TreeNode hash={root} isRoot />
    </div>
  );
}

type BranchMap = Record<string, HighlightKind>;

async function computeBranchHighlightMap(
  leafHash: string,
  merklePath: MerklePathNode[],
): Promise<BranchMap> {
  const map: BranchMap = {};
  map[leafHash] = "leaf";

  let current = leafHash;
  for (const node of merklePath) {
    const left = node.position === "left" ? node.hash : current;
    const right = node.position === "right" ? node.hash : current;
    const parent = await sha256Hex(left + right);
    if (!map[node.hash]) {
      map[node.hash] = "sibling";
    }
    map[parent] = "branch";
    current = parent;
  }

  return map;
}

export default function MerkleTreeViz({ ballotEventId }: Props) {
  const [result, setResult] = useState<FinalResultInfo | null>(null);
  const [tree, setTree] = useState<VoteTreeResponse | null>(null);
  const [proof, setProof] = useState<InclusionProofResponse | null>(null);
  const [verificationStatus, setVerificationStatus] = useState<"idle" | "loading" | "verified" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  const [branchMap, setBranchMap] = useState<BranchMap>({});

  const hasBranchHighlight = useMemo(() => Object.keys(branchMap).length > 0, [branchMap]);

  function getHighlight(hash: string, isMyVote: boolean): HighlightKind {
    if (isMyVote) return "leaf";
    const kind = branchMap[hash];
    return kind ?? "none";
  }

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
    setBranchMap({});
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
        if (rootMatch) {
          const hm = await computeBranchHighlightMap(p.leaf_hash, p.merkle_path);
          setBranchMap(hm);
          setVerificationStatus("verified");
        } else {
          setVerificationStatus("failed");
          setError("Proof root does not match final result root.");
        }
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
            {hasBranchHighlight && (
              <div style={{ display: "flex", gap: 16, marginBottom: 8, fontSize: "0.7rem", color: "var(--muted)" }}>
                <span><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: "rgba(88,59,39,0.18)", border: "1px solid var(--accent)", verticalAlign: "middle", marginRight: 4 }} />Your vote</span>
                <span><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: "rgba(88,59,39,0.10)", borderLeft: "4px solid var(--accent)", verticalAlign: "middle", marginRight: 4 }} />Branch path</span>
                <span><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: "rgba(88,59,39,0.06)", borderLeft: "4px dashed rgba(88,59,39,0.35)", verticalAlign: "middle", marginRight: 4 }} />Sibling</span>
              </div>
            )}
            <div style={{ overflowX: "auto", padding: "8px 0" }}>
              {[...tree.levels].reverse().map((level, levelIdx) => (
                <div key={levelIdx} style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 4, justifyContent: "center" }}>
                  {level.map((hash, nodeIdx) => {
                    const isLeafLevel = levelIdx === tree.levels.length - 1;
                    const leafEvent = isLeafLevel
                      ? tree.leaves.find(l => l.hash === hash)
                      : null;
                    const isMyVote = Boolean(ballotEventId && leafEvent?.event_id === ballotEventId);
                    const highlight = getHighlight(hash, isMyVote);
                    return (
                      <div key={nodeIdx} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1 }}>
                        <TreeNode hash={hash} highlight={highlight} isRoot={levelIdx === 0} />
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
                <TreeNode hash={proof.leaf_hash} highlight="leaf" />
              </div>
              <MerklePathViz path={proof.merkle_path} leafHash={proof.leaf_hash} root={proof.merkle_root} />
            </div>
          </div>
        )}
      </article>
  );
}
