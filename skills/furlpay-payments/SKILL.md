---
name: furlpay-payments
description: Move stablecoins with FurlPay — gasless USDC transfers on EVM via ERC-4337, Solana Actions and Blinks, fee handling, and idempotent execution. Use when a developer is building a send or checkout flow, asks how a user pays without holding gas, is doing arithmetic on token amounts, needs a retried payment not to charge twice, or is deciding whether to trust a client-supplied amount. Covers atomic-unit arithmetic, why float money is a bug, and the ordering that keeps a timeout from becoming a double-spend.
---

# FurlPay payments

The user signs an authorization. FurlPay submits the transaction and pays the gas.
That is what "gasless" means here — not that gas is free, but that the payer never
has to hold the native token of a chain they may not know they are on.

## Money is never a float

```ts
0.1 + 0.2                    // 0.30000000000000004
```

Every amount is an **integer in the asset's smallest unit**. USDC has 6 decimals, so
$1.00 is `1_000_000`. Use `bigint`, not `number` — beyond 2^53 a JavaScript number
silently loses precision, and token amounts reach that.

```ts
const oneUsdc = 1_000_000n;                        // USDC: 6 decimals
const amount  = BigInt(Math.round(usd * 1e6));     // convert ONCE, at the boundary
```

Convert at the edge and stay integer inside. Rounding at each step is how a balance
drifts away from the ledger by amounts too small to notice and too persistent to
reconcile.

**Never sum, compare or apply a percentage to a decimal string.** Parse to `bigint`
first. A fee computed on a float and an amount computed in atomic units will disagree,
and the difference has to come out of someone's balance.

## EVM: gasless via ERC-4337

```
user signs an EIP-712 authorization   (off-chain, no gas, no native token)
        ↓
bundler submits a UserOperation
        ↓
USDCPaymaster sponsors the gas
        ↓
FurlPayRouter executes and captures the fee
```

The payer never holds ETH. `FurlPayRouter` captures the platform fee —
**`FEE_RATE = 0.005`, i.e. 0.5%** — in the same transaction that moves the principal,
so the fee cannot silently diverge from the transfer it belongs to.

Contract addresses come from environment configuration. **A deployment whose contract
address is unset must refuse to transact, not fall back.** A payment path that
proceeds against an unconfigured address is a payment path that loses money.

## Solana: Actions and Blinks

A Solana Action is a URL that returns a signable transaction; a Blink is that URL
unfurled into a widget on X, Discord or anywhere else that renders it.

```
GET  /api/actions/pay/:orderId   → metadata: title, description, price, action links
POST /api/actions/pay/:orderId   → { account } → serialized transaction to sign
```

The **server** builds the transaction. The client supplies only its public key. Never
accept a client-constructed transaction and sign or forward it — you would be
executing instructions you did not author, against your own accounts.

Validate `account` before use:

```ts
try { payer = new PublicKey(body.account); }
catch { return json({ message: 'Invalid "account"' }, { status: 400 }); }
```

`new PublicKey()` is a base58 decode plus a 32-byte length assertion. A regex is not
equivalent — plenty of base58 strings of the right length are not valid keys.

## Idempotency

Networks time out. Clients retry. Without a key, a retry is a second payment.

```ts
await fetch("/api/payments", {
  method: "POST",
  headers: { "Idempotency-Key": crypto.randomUUID() },  // per logical payment
  body: JSON.stringify({ amount, destination }),
});
```

One key per **logical payment**, reused across every retry of that payment. A key
generated per HTTP attempt provides nothing. `crypto.randomUUID()` — never
`Math.random()`.

Server-side the key is claimed atomically before the handler runs, so two concurrent
retries cannot both execute: the first wins, the second replays the cached response,
and a third arriving mid-flight gets a 409.

## Ordering: record before you submit

```
1. record the payment as `created`      ← BEFORE the provider call
2. submit to the provider / chain
3. reconcile against what actually happened
```

A submission that times out then leaves a record of an order whose outcome is
**unknown** — which is the truth, and is recoverable. Submitting first and recording
after leaves nothing at all when the process dies between the two, and an unrecorded
submission is money you cannot find.

**Do not collapse an indeterminate outcome into success or failure.** A provider
timeout means you do not know. Model that state explicitly and reconcile it; guessing
either way produces a wrong balance.

## Never trust the client

Amount, recipient, asset and fee come from **server-issued** state — a quote, an
order, a payment intent. A request that carries its own price is a request that sets
its own price.

```ts
// wrong
const amount = body.amount;

// right
const order = await getOrder(body.orderId);   // server-side, authoritative
const amount = order.amountAtomic;
```

## Security rules

- Validate every body against a schema. Amounts get `.positive()` **and an upper
  bound** — an unbounded amount is a bug waiting for a bad actor.
- Rate-limit money-moving routes per **user**, not per IP. An IP bucket is shared by
  everyone behind a carrier NAT.
- Never log a signature, an authorization payload or a private key. Log the payment id.
- Validate addresses per chain before sending. See `furlpay-wallet`.
- Fail closed. Missing signer key, unset contract address, unreachable provider — all
  return an error. None fabricates a settlement.
