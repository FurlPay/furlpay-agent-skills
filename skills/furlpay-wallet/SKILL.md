---
name: furlpay-wallet
description: Work with FurlPay wallets across chains — validating addresses per chain, deriving Solana associated token accounts, reading balances, and keeping displayed balances honest. Use when a developer is accepting an address as input, building a send form, seeing "invalid address" or funds sent to a chain the recipient does not control, deriving an ATA for a USDC transfer, or asking why a balance differs between two screens. Covers the per-chain validation that a single regex cannot do, and why an address and a network must be checked together.
---

# FurlPay wallets

An address is not a string. It is a string **on a specific chain**, and the pair is
the unit of correctness — validating one without the other is the failure mode that
sends funds somewhere nobody controls.

## Step 1 — Validate per chain, never generically

A union regex over base58 and hex characters accepts `ethereum:<base58 junk>` as an
Ethereum address. FurlPay validates per chain:

```ts
import { isEvmAddress, isSolanaAddress, classifyAddress, isValidForChainKind }
  from "@/lib/addressValidation";
```

**EVM** — `/^0x[0-9a-fA-F]{40}$/`. A regex is sufficient here because the format is
fixed-width hex. Checksummed (EIP-55) casing is a stronger check where you have it,
but the shape check is the floor.

**Solana** — a regex is **not** sufficient. `^[1-9A-HJ-NP-Za-km-z]{32,44}$` matches
plenty of strings that are not valid keys, because base58 length does not imply a
32-byte decode. The real check is a base58 decode plus a 32-byte assertion:

```ts
try { new PublicKey(value); } catch { /* not a Solana address */ }
```

`isSolanaAddress` reproduces exactly that. Both verdicts agree, so either is safe.

**Never lowercase a Solana address.** Base58 is case-sensitive — `A` and `a` are
different characters. Lowercasing an EVM address for comparison is fine and normal;
doing it to base58 corrupts it, and two distinct addresses can collide.

## Step 2 — Check the address against the network, together

This is the check that types will not do for you. An EVM address paired with a Solana
network passes every string-shape validator and every TypeScript union — and routes
funds to an address that does not exist on the settlement chain.

```ts
if (!isValidForChainKind(address, chainKind)) {
  return { ok: false, error: "address is not valid for this chain" };
}
```

Do this at the **boundary** — the moment an address and a network arrive together,
before either reaches a quote, a transaction builder, or storage. Validating them
separately is not validating them.

## Step 3 — Solana USDC needs an ATA, not the wallet address

A common and expensive mistake: sending SPL tokens to a wallet address. SPL tokens
live in an **associated token account** derived from the wallet **and the mint**.

```ts
const [destinationATA] = await findAssociatedTokenPda({
  mint: usdcMint,      // the token
  owner: recipient,    // the wallet
  tokenProgram,
});
```

Two consequences worth internalising:

- **The ATA depends on the mint.** The same wallet has a different ATA for USDC than
  for any other token. Deriving with the wrong mint sends to the wrong account.
- **The ATA may not exist yet.** A wallet that has never held USDC has no USDC ATA.
  Create it (the sender pays rent) or the transfer fails.

Because the ATA is derived from `(mint, owner)`, checking that a transfer's
destination equals the derived ATA binds recipient **and** asset in one comparison.
That is a stronger guarantee than comparing a recipient string, and it is why token
substitution is structurally hard on Solana.

## Step 4 — Balances are derived, not stored

A balance is the sum of the ledger's postings, not a mutable column. When a stored
balance and the derived balance disagree, **the ledger is right**.

Two numbers a UI must not conflate:

- **on-chain balance** — what the chain says the address holds
- **available balance** — what the user may spend now, after pending debits and holds

Showing an on-chain balance as spendable lets a user commit funds already reserved.
Label which one you are rendering.

**Never display a stale balance as live.** If the read failed, say so. An amount with
no freshness qualifier is read as current, and on a money screen that is a lie the
interface is telling on your behalf.

## Debugging

| Symptom | Cause |
|---|---|
| "invalid address" on a correct-looking Solana address | Lowercased somewhere. Base58 is case-sensitive. |
| Transfer succeeds, recipient sees nothing | Sent to the wallet address, not the ATA — or the ATA of a different mint. |
| Transaction fails, no clear reason | Destination ATA does not exist. Create it. |
| Funds gone, recipient cannot access | Address valid in format, wrong chain. Check `isValidForChainKind` at the boundary. |
| Two screens show different balances | One renders on-chain, the other available. Both may be right. |

## Security rules

- Validate an externally-supplied address before it reaches a quote or a transaction.
- Never accept a chain from the client for a server-issued quote. The quote pins it.
- Do not log full addresses at info level — truncate for display; keep the full value
  in the record, not the log line.
- Address-book entries are a **safety** control, not a convenience: the failure they
  remove is pasting 42 characters that look right and are not. Validate on save, and
  again before send.
