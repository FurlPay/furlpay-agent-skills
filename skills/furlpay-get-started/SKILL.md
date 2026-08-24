---
name: furlpay-get-started
description: Orient in the FurlPay platform and set up a first integration — pick the right SDK or package for the task, configure API keys and environment variables, understand sandbox versus live mode, and route to the specialised FurlPay skills. Use this when a developer is starting a FurlPay integration, asks "how do I use FurlPay", is unsure which FurlPay package they need, or hits a 503 / "not configured for production" error and does not know why.
---

# Getting started with FurlPay

FurlPay is stablecoin payment infrastructure: wallets, cards, investing, travel, and
per-call API payments for AI agents. Start by choosing the right package — the most
common wasted hour is building against the wrong one.

## Step 1 — Pick the package

| You want to | Use |
|---|---|
| Call the FurlPay API from a server | `@furlpay/furlpay-node` (also Python, Go, Rust SDKs) |
| Charge per API call / paywall an MCP tool | `@furlpay/gateway` → skill `furlpay-x402` |
| Receive events | any SDK's `webhooks` → skill `furlpay-webhooks` |
| Embed checkout UI | `@furlpay/elements` |
| Smart accounts, passkeys, escrow | `@furlpay/account-kit` |
| Give an AI agent FurlPay tools | `@furlpay/mcp-server` |
| Forward webhooks / trigger test events locally | `@furlpay/cli` |
| Harden a facilitator you operate | `@furlpay/x402-guard` |

Every package is MIT and most have zero runtime dependencies. That is deliberate: a
payment library is a supply-chain surface, and each dependency is another party who
can reach your money path.

## Step 2 — Configure the environment

Secrets live in env vars **without** the `NEXT_PUBLIC_` prefix. Anything with that
prefix is compiled into the browser bundle and is public — putting a secret key there
publishes it.

```bash
FURLPAY_API_KEY=            # server-side API key
FURLPAY_ENDPOINT_SECRET=    # per-endpoint webhook signing secret
INTEGRATION_MODE=mock       # mock | live
```

Ask the developer which environment they are targeting before generating code that
reads these. Sandbox and live keys are not interchangeable, and a sandbox key against
a live endpoint fails in a way that looks like a bug in the integration.

## Step 3 — Understand mock vs live

`INTEGRATION_MODE` gates every third-party seam:

- **`mock`** — no credentials needed. Deterministic fake responses. Correct for
  development and previews.
- **`live`** — real credentials, real settlement, real money.

The state that does **not** exist is "production with mocks". A production deployment
without live configuration returns **503**, deliberately. A mock settlement
fabricates a transaction hash and a mock signature check passes any well-formed blob;
allowing that in production would mean crediting balances against payments that never
happened.

**So a 503 saying "not configured for production" is not a bug.** It means live mode
is on and a required credential is missing. The fix is to supply the credential, never
to relax the guard.

## Step 4 — First call

```ts
import { Furlpay } from "@furlpay/furlpay-node";

const furlpay = new Furlpay({ apiKey: process.env.FURLPAY_API_KEY! });
const wallet = await furlpay.wallets.retrieve();
```

## Step 5 — Route to the right skill

- Receiving events → **`furlpay-webhooks`** (raw-body handling is the usual blocker)
- Selling API access to agents → **`furlpay-x402`**

## Rules that apply to every FurlPay integration

These come from the platform's own engineering rules. An agent generating FurlPay
code should hold to them without being asked:

1. **Validate every request body against a schema.** Money amounts get a positive
   check and an upper bound — an unbounded amount is a bug waiting for a bad actor.
2. **Rate-limit anything money-moving**, keyed per user rather than per IP. An IP
   bucket is shared by everyone behind a carrier NAT.
3. **Use idempotency keys on mutating calls.** Send `Idempotency-Key` with a UUID; a
   retried POST must not charge twice.
4. **Never merge raw client JSON into a stored object.** Whitelist fields explicitly —
   mass assignment is how a client sets a field you never exposed.
5. **Never return secrets.** Not MFA secrets, not private keys, not session tokens,
   not full PII — in responses, in logs, or in error messages.
6. **Use `crypto.randomUUID()` for anything security-relevant.** `Math.random()` is
   predictable and must never generate an id, nonce or token.
7. **Fail closed.** When a credential is missing or a provider is unreachable, return
   an error. Never fall back to a path that fabricates success.

## Common first-time errors

| Symptom | Cause |
|---|---|
| 503 "not configured for production" | Live mode, missing credential. Supply it. |
| Webhook signature always fails | Body parsed before verification. See `furlpay-webhooks`. |
| 401 on every call | Sandbox key against live, or the `NEXT_PUBLIC_` prefix leaked a publishable key into a server slot. |
| 429 | Rate limited. Back off; do not retry in a tight loop. |
