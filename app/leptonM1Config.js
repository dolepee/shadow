export const LEPTON_M1_DEPLOYMENTS = Object.freeze({
  currentRead: Object.freeze({
    generation: "m1-caller-hardened-2026-06-25",
    mandateRegistry: "0xe3cf1a4d54f627f599255142cef4bf9b8c361a4c",
    mandateAttestor: "0x9b5afc6c442364d4397763917ebbc659d85ee86d",
    bondedEnforcer: "0x1825f447c0aa8e64dd2d290cdce85d82993d0e1e",
    v4StyleAdapter: "0xd890db70ba5135141a5d4522ba36fc0ca7cad177",
    v4StyleSink: "0x10eacc425f7ac090b14f3f5f59ad59df033a55ce",
    morphoStyleAdapter: "0xba9f134f7b13dadd45dcf16b09c5121a7555e2c5",
    morphoStyleSink: "0x110f79c5617797b199d3d6e2abb855c34fbc5e58",
    sourceVerified: false,
    canonicalWriteAllowlisted: false,
    sinkRecoverable: false,
    expectedWriteBlockers: Object.freeze([
      "BOND_ZERO",
      "GENERATION_NOT_ALLOWLISTED",
      "SOURCE_NOT_VERIFIED",
      "SINK_NOT_RECOVERABLE",
    ]),
  }),
  historicalProofs: Object.freeze({
    circlePasskey: Object.freeze({
      generation: "m1-passkey-proof-2026-06-19",
      label: "Historical June 19 Circle passkey proof",
      txHash: "0x98b8b175d4ec8bf6d457d653383932e69d74300bd0b8a7e324e0cae3ac35a529",
      mandateRegistry: "0x394b6955162ce147e813e0eea6104cd1164e3d33",
      bondedEnforcer: "0x05a11588155c6bde55bb7b3986f200ca556b23cc",
      v4StyleAdapter: "0x16ebc65c9f3188734277c9fafd73d9f13b93d868",
      v4StyleSink: "0x2b18c771466f8647df2ef32a459fcc54438b2de7",
    }),
    morphoStyle: Object.freeze({
      generation: "m1-caller-hardened-2026-06-25",
      label: "Morpho-style testnet proof",
      adapter: "0xba9f134f7b13dadd45dcf16b09c5121a7555e2c5",
      sink: "0x110f79c5617797b199d3d6e2abb855c34fbc5e58",
      allowTx: "0x9836e74ee95907847fac464f3a65554cf314adab9efe7141f4644022b3e09c17",
      blockTx: "0x7d3dddd89dc50ea5b410564c7f1134ce1350fd3687e8cefec74192d9e9b4bd23",
    }),
  }),
});

export const LEPTON_WRITE_REASON = Object.freeze({
  NOT_CONFIGURED: "NOT_CONFIGURED",
  RPC_READ_FAILED: "RPC_READ_FAILED",
  ADAPTER_CODE_MISSING: "ADAPTER_CODE_MISSING",
  SINK_CODE_MISSING: "SINK_CODE_MISSING",
  BOND_ZERO: "BOND_ZERO",
  BOND_BELOW_MINIMUM: "BOND_BELOW_MINIMUM",
  GENERATION_NOT_ALLOWLISTED: "GENERATION_NOT_ALLOWLISTED",
  SOURCE_NOT_VERIFIED: "SOURCE_NOT_VERIFIED",
  WRONG_ENFORCER: "WRONG_ENFORCER",
  WRONG_SINK_BINDING: "WRONG_SINK_BINDING",
  SINK_NOT_RECOVERABLE: "SINK_NOT_RECOVERABLE",
});

const REASON_COPY = Object.freeze({
  [LEPTON_WRITE_REASON.NOT_CONFIGURED]: "The current V4 read deployment is not fully configured.",
  [LEPTON_WRITE_REASON.RPC_READ_FAILED]: "Live contract readiness could not be re-read from Arc.",
  [LEPTON_WRITE_REASON.ADAPTER_CODE_MISSING]: "The configured V4 adapter has no deployed code.",
  [LEPTON_WRITE_REASON.SINK_CODE_MISSING]: "The configured V4 sink has no deployed code.",
  [LEPTON_WRITE_REASON.BOND_ZERO]: "The current V4 adapter has no enforcer bond.",
  [LEPTON_WRITE_REASON.BOND_BELOW_MINIMUM]: "The current V4 adapter bond is below the required minimum.",
  [LEPTON_WRITE_REASON.GENERATION_NOT_ALLOWLISTED]: "This deployment generation is not allowlisted for writes.",
  [LEPTON_WRITE_REASON.SOURCE_NOT_VERIFIED]: "This deployment generation is not source-verified for writes.",
  [LEPTON_WRITE_REASON.WRONG_ENFORCER]: "The adapter is bound to an unexpected enforcer.",
  [LEPTON_WRITE_REASON.WRONG_SINK_BINDING]: "The adapter and sink binding do not match the declared generation.",
  [LEPTON_WRITE_REASON.SINK_NOT_RECOVERABLE]: "The configured sink is archival and has no recovery path.",
});

export function classifyLeptonV4Readiness(input) {
  const reasonCodes = [];
  const add = (condition, code) => {
    if (condition && !reasonCodes.includes(code)) reasonCodes.push(code);
  };

  add(!input.readConfigured, LEPTON_WRITE_REASON.NOT_CONFIGURED);
  add(!input.rpcOk, LEPTON_WRITE_REASON.RPC_READ_FAILED);
  add(input.rpcOk && !input.adapterHasCode, LEPTON_WRITE_REASON.ADAPTER_CODE_MISSING);
  add(input.rpcOk && !input.sinkHasCode, LEPTON_WRITE_REASON.SINK_CODE_MISSING);
  add(input.rpcOk && input.adapterBondUSDC === 0n, LEPTON_WRITE_REASON.BOND_ZERO);
  add(
    input.rpcOk && input.adapterBondUSDC > 0n && input.adapterBondUSDC < input.minBondUSDC,
    LEPTON_WRITE_REASON.BOND_BELOW_MINIMUM,
  );
  add(!input.generationWriteAllowlisted, LEPTON_WRITE_REASON.GENERATION_NOT_ALLOWLISTED);
  add(!input.generationSourceVerified, LEPTON_WRITE_REASON.SOURCE_NOT_VERIFIED);
  add(input.rpcOk && !sameAddress(input.actualEnforcer, input.expectedEnforcer), LEPTON_WRITE_REASON.WRONG_ENFORCER);
  add(
    input.rpcOk &&
      (!sameAddress(input.actualSink, input.expectedSink) || !sameAddress(input.sinkAdapter, input.expectedAdapter)),
    LEPTON_WRITE_REASON.WRONG_SINK_BINDING,
  );
  add(!input.sinkRecoverable, LEPTON_WRITE_REASON.SINK_NOT_RECOVERABLE);

  return Object.freeze({
    readConfigured: Boolean(input.readConfigured),
    writeReady: reasonCodes.length === 0,
    reasonCodes: Object.freeze(reasonCodes),
    userCopy:
      reasonCodes.length === 0
        ? "This source-verified canonical generation is ready for a wallet request."
        : `${REASON_COPY[reasonCodes[0]]} No wallet request will be made.`,
  });
}

export async function runLeptonWalletAction(readiness, action) {
  if (!readiness?.writeReady) {
    throw new Error(readiness?.userCopy || "The V4 action is not write-ready. No wallet request will be made.");
  }
  return action();
}

export async function readWithCanonicalFallback(primaryRead, canonicalRead) {
  try {
    return await primaryRead();
  } catch (primaryError) {
    if (typeof canonicalRead !== "function") throw primaryError;
    try {
      return await canonicalRead();
    } catch (canonicalError) {
      throw new AggregateError(
        [primaryError, canonicalError],
        "The historical proof read failed on both the configured and canonical RPC.",
      );
    }
  }
}

export function transactionInputContainsAddress(input, address) {
  if (!/^0x[0-9a-f]*$/i.test(String(input || "")) || !/^0x[0-9a-f]{40}$/i.test(String(address || ""))) return false;
  const paddedAddress = String(address).slice(2).toLowerCase().padStart(64, "0");
  return String(input).slice(2).toLowerCase().includes(paddedAddress);
}

function sameAddress(left, right) {
  return Boolean(left && right && String(left).toLowerCase() === String(right).toLowerCase());
}
