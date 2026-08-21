import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const contractsRoot = resolve(here, "..");
const artifactPath = resolve(
  contractsRoot,
  "out/ShadowFloatMainnet.sol/ShadowFloatMainnet.json",
);
const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));

const runtimeHex = artifact.deployedBytecode.object.replace(/^0x/, "");
const runtimeBytes = runtimeHex.length / 2;
assert.ok(runtimeBytes <= 18_432, `runtime is ${runtimeBytes} bytes`);

const exposedNames = artifact.abi
  .filter((item) => item.type === "function" || item.type === "event")
  .map((item) => item.name.toLowerCase());
const forbiddenFragments = [
  "fee",
  "grantfloat",
  "treasury",
  "pool",
  "yield",
  "transferdebt",
  "leverage",
  "policypool",
  "morpho",
  "uniswap",
  "adapter",
  "score",
  "upgradeto",
  "implementation",
];

for (const name of exposedNames) {
  for (const fragment of forbiddenFragments) {
    assert.ok(
      !name.includes(fragment),
      `forbidden Mainnet V1 ABI/event surface: ${name}`,
    );
  }
}

const source = readFileSync(
  resolve(contractsRoot, "src/ShadowFloatMainnet.sol"),
  "utf8",
);
const imports = [...source.matchAll(/^import\s+[^;]+;/gm)].map(([value]) => value);
assert.deepEqual(imports, ['import {IERC20} from "./interfaces/IERC20.sol";']);

console.log(
  `ShadowFloatMainnet scope gate PASS: ${runtimeBytes} runtime bytes, ${exposedNames.length} ABI/event names`,
);
