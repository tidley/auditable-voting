import { createHash } from "crypto";

export type MerklePathNode = {
  position: "left" | "right";
  hash: string;
};

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function computeLeaf(
  eventId: string,
  pubkey: string,
  voteChoice: string,
  timestamp: number
): string {
  const encoded = `${eventId}|${pubkey}|${voteChoice}|${timestamp}`;
  return sha256(encoded);
}

export function buildMerkleTree(leaves: string[]) {
  if (leaves.length === 0) {
    throw new Error("No leaves provided");
  }

  const levels: string[][] = [];
  levels.push([...leaves]);

  while (levels[levels.length - 1].length > 1) {
    const current = levels[levels.length - 1];
    const next: string[] = [];

    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      const right = current[i + 1] ?? current[i];
      next.push(sha256(left + right));
    }

    levels.push(next);
  }

  return {
    root: levels[levels.length - 1][0],
    levels
  };
}

export function getMerkleProof(
  levels: string[][],
  index: number
): MerklePathNode[] {
  const path: MerklePathNode[] = [];

  for (let level = 0; level < levels.length - 1; level++) {
    const nodes = levels[level];
    const isRightNode = index % 2 === 1;
    const pairIndex = isRightNode ? index - 1 : index + 1;

    const pairHash = nodes[pairIndex] ?? nodes[index];

    path.push({
      position: isRightNode ? "left" : "right",
      hash: pairHash
    });

    index = Math.floor(index / 2);
  }

  return path;
}

export function verifyMerkleProof(
  leaf: string,
  path: MerklePathNode[],
  root: string
): boolean {
  let computed = leaf;

  for (const node of path) {
    if (node.position === "left") {
      computed = sha256(node.hash + computed);
    } else {
      computed = sha256(computed + node.hash);
    }
  }

  return computed === root;
}
