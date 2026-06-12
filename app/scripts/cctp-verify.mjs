const baseUrl = (process.env.SHADOW_APP_URL || "https://shadow-arc.vercel.app").replace(/\/$/, "");
const burnTx = process.env.CCTP_BURN_TX || process.argv[2];
const sourceDomain = process.env.CCTP_SOURCE_DOMAIN || process.argv[3];
const follower = process.env.CCTP_FOLLOWER || process.argv[4];
const expectedAmountAtomic = process.env.CCTP_EXPECTED_AMOUNT_ATOMIC || process.argv[5];

if (!burnTx || !sourceDomain) {
  console.error("usage: CCTP_BURN_TX=0x... CCTP_SOURCE_DOMAIN=6 pnpm cctp:verify");
  console.error("or: node scripts/cctp-verify.mjs 0xBurnTx 6 [0xFollower] [expectedAmountAtomic]");
  process.exit(1);
}

const res = await fetch(`${baseUrl}/api/cctp-funding`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    burnTx,
    sourceDomain,
    follower,
    expectedAmountAtomic,
  }),
});

console.log("HTTP", res.status);
console.log(JSON.stringify(await res.json(), null, 2));
