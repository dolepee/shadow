import { readFileSync } from "node:fs";
import { citePayClearCommitment } from "./citepay-clear-gate.mjs";

const path = process.argv[2];
if (!path) {
  throw new Error("usage: node app/scripts/citepay-clear-commit.mjs signed-intent-draft.json");
}

const payload = JSON.parse(readFileSync(path, "utf8"));
const commitment = citePayClearCommitment(payload.citepayClear ?? payload);
console.log(JSON.stringify({ commitment, reason: `citepay-clear:${commitment}` }, null, 2));
