---
name: furlpay-x402
description: Sell API access to AI agents over HTTP 402 with stablecoin payment, or build a client that pays a 402 automatically. Use when a developer wants to paywall an API/MCP tool per call, is integrating @furlpay/gateway or the FurlPay facilitator, is choosing between x402 v1 and v2 wire formats, or is debugging replay/"nonce already used"/"quote already redeemed" errors. Covers the exact 402 handshake, EIP-3009 off-chain authorization, the dual atomic claim that prevents double delivery, and confirmation-depth gating.
---

# FurlPay x402

x402 revives HTTP `402 Payment Required` as a real status code: a server answers an
unpaid request with machine-readable payment terms, the client pays, and retries. It
is how an AI agent buys one API call without an account, a card, or a human.

## The payment model people get wrong

**The client signs an EIP-3009 authorization off-chain. It never submits a
transaction and never holds gas.** The facilitator submits and pays the gas.

Any design that asks the payer for a transaction hash is not x402 — that is a
pay-then-prove flow, and it has a different (worse) trust model, because the server
must then decide whether an arbitrary hash really paid it.

## The handshake

```
1. GET /premium/report                     → no payment attached
2. 402 + payment terms                     ← server states amount, asset, network, payTo, resource
3. client signs EIP-3009 authorization     (off-chain, no gas, no tx)
4. GET /premium/report + payment header     → retry with the signed authorization
5. facilitator verifies, then settles       (submits on-chain, pays gas)
6. 200 + receipt header                    ← resource released after confirmation depth
```

## Two wire dialects — answer in the one the client spoke

FurlPay speaks **both v1 and v2**, and negotiates per request. A 402 advertises both
at once: v2 terms in the `PAYMENT-REQUIRED` header, v1 terms in the body.

| | v1 | v2 |
|---|---|---|
| request header | `X-PAYMENT` | `PAYMENT-SIGNATURE` |
| response header | `X-PAYMENT-RESPONSE` | `PAYMENT-RESPONSE` |
| terms location | response **body** | `PAYMENT-REQUIRED` **header** |
| amount field | `maxAmountRequired` | `amount` |
| quote echo | `payload.extra` | `payload.accepted` |

Do **not** "migrate" a server from v1 to v2 by replacing the headers. That breaks
every v1 client. Emit both; read whichever arrived. Set
`Vary: X-PAYMENT, PAYMENT-SIGNATURE` so caches do not serve one dialect's response to
the other.

## Selling: paywall an endpoint

```ts
import { paywall } from "@furlpay/gateway";

const pay = paywall({
  price: 0.01,                       // USD
  payTo: process.env.FURLPAY_PAY_TO!,
  quoteSecret: process.env.X402_QUOTE_SECRET!,
  claimStore: upstashClaimStore(),   // REQUIRED in production — see below
});
```

`@furlpay/gateway` is zero-dependency and framework-agnostic; adapters exist for
Express, fetch handlers and a reverse proxy.

## The two single-use tokens

This is the part that actually prevents double delivery, and it is why an in-memory
claim store is not production-safe.

Every payment burns **two** tokens, each claimed atomically (Redis `SET NX`) **before
any resource is released**:

- **the EIP-3009 nonce** — the money-level token. Stops the same authorization paying twice.
- **the quoteId** — the resource-level token. Stops one payment redeeming a different resource.

```ts
if (!(await claimOnce("nonce", auth.nonce)))  return reject("Authorization nonce already used (replay rejected)");
if (!(await claimOnce("quote", quoteId)))     return reject("Quote already redeemed (replay rejected)");
```

`SET NX` linearises both across every serverless instance, so a replay — same
instance, another instance, or genuinely concurrent — loses the claim and is rejected
before delivery. Claims hold for 24h, which is past any authorization's validity.

**Both claims must happen before the response body is written.** A claim taken after
delivery has prevented nothing.

**A failed settlement must NOT release the claim.** The transaction may still confirm;
freeing the nonce reopens the replay window. Honest retries use a fresh EIP-3009
nonce, so keeping it burned never blocks a legitimate caller.

## Confirmation depth

Never release a resource on an unconfirmed settlement. A chain reorg turns a
delivered resource into an unpaid one, and there is no way to un-deliver it. Required
depth scales with amount — a $0.001 API call and a $400 booking do not warrant the
same wait. Below the required depth, fail closed and keep the nonce burned.

## Buying: pay a 402 automatically

```ts
const res = await fetch(url);
if (res.status === 402) {
  const terms = parseTerms(res);          // PAYMENT-REQUIRED header (v2) or body (v1)

  // Check terms against policy BEFORE signing. The 402 is attacker-controlled input.
  assertAllowed(terms);                   // amount, asset, network, payTo

  const authorization = await signEip3009(terms);
  return fetch(url, { headers: { "PAYMENT-SIGNATURE": encode(authorization) } });
}
```

**Never sign a 402's terms unchecked.** A malicious or compromised resource server
states its own price, asset and recipient. An agent that signs whatever arrives will
pay an arbitrary amount to an arbitrary address. Enforce a per-call cap, an asset
allowlist and a network allowlist before signing — the policy check is the control,
not the protocol.

## Debugging

| Error | Cause |
|---|---|
| `Authorization nonce already used` | Replay, or a client retrying without a fresh nonce. Correct behaviour. |
| `Quote already redeemed` | The quote was spent on another request. Re-request the 402. |
| `Quote expired` | Quotes are short-lived. Re-request; do not extend the window. |
| `insufficient_confirmations` | Settled but not deep enough yet. Retry the read; the nonce stays burned. |
| `settler_unavailable` | Live mode with no signing key configured. Refusing to fabricate a settlement is correct. |
| `invalid_network` | Client changed `network` after the 402. Correct rejection. |

## Security rules

- The server states the terms. Never accept amount, asset, network or `payTo` from the client.
- Claim before delivering, always.
- Fail closed when unconfigured. A missing key must produce a 503, never a fabricated settlement.
- Do not log the payment payload — it carries a signature. Log the payment id.
- Paid responses must not be cached. Set `Cache-Control: no-store`, or one payment
  serves many callers from a shared cache.
