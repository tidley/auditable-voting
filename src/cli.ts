import { publishVote } from "./nostrClient.js";
import { buildMerkleTree, computeLeaf, getMerkleProof, verifyMerkleProof } from "./merkle.js";
import { startVoterServer } from "./voterServer.js";

async function main() {
  const cmd = process.argv[2];

  if (cmd === "submit-vote") {
    const relay = process.argv[3];
    const electionId = process.argv[4];
    const choice = process.argv[5];

    if (!relay || !electionId || !choice) {
      console.error("Usage: submit-vote <relay> <electionId> <choice>");
      process.exit(1);
    }

    const result = await publishVote(relay, {
      electionId,
      voteChoice: choice
    });

    console.log("Vote published:");
    console.log(JSON.stringify(result, null, 2));
  }

  else if (cmd === "start-server") {
    const portArg = process.argv[3] ?? "8789";
    const port = Number(portArg);

    if (!Number.isInteger(port) || port <= 0) {
      console.error("Usage: start-server <port>");
      process.exit(1);
    }

    await startVoterServer(port);
  }

  else if (cmd === "build-merkle") {
    const leavesInput = process.argv.slice(3);

    if (leavesInput.length === 0) {
      console.error("Usage: build-merkle <leaf1> <leaf2> ...");
      process.exit(1);
    }

    const tree = buildMerkleTree(leavesInput);
    console.log("Merkle root:", tree.root);
  }

  else if (cmd === "prove") {
    const index = Number(process.argv[3]);
    const leaves = process.argv.slice(4);

    const tree = buildMerkleTree(leaves);
    const proof = getMerkleProof(tree.levels, index);

    console.log(JSON.stringify({
      leaf: leaves[index],
      proof,
      root: tree.root
    }, null, 2));
  }

  else if (cmd === "verify") {
    const leaf = process.argv[3];
    const root = process.argv[4];
    const pathJson = process.argv[5];

    const path = JSON.parse(pathJson);

    const valid = verifyMerkleProof(leaf, path, root);
    console.log("Valid:", valid);
  }

  else {
    console.log("Commands:");
    console.log("  start-server <port>");
    console.log("  submit-vote <relay> <electionId> <choice>");
    console.log("  build-merkle <leaf1> <leaf2> ...");
    console.log("  prove <index> <leaf1> <leaf2> ...");
    console.log("  verify <leaf> <root> <pathJson>");
  }
}

main();
