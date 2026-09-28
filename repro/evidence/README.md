Evidence files written by `client.mjs`.

- `offline-*.json`: fake facilitator, throwaway key. Shows the mechanism only;
  transaction hashes are synthetic (`0xfake…`).
- `sepolia-*.json`: your Base Sepolia deployment via `x402.org/facilitator`;
  transaction hashes are real testnet transactions.

Only the two offline runs are committed. Testnet runs are ignored by git so a
key or receiver address is never committed by accident; copy them in
deliberately if you want them in the repo.
