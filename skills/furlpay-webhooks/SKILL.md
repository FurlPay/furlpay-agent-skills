---
name: furlpay-webhooks
description: Implement and verify FurlPay webhook endpoints. Use when a developer is adding a FurlPay webhook receiver, debugging "signature verification failed", handling payment.settled / card.transaction.created / booking events, or asking why their raw body is empty. Covers the exact HMAC-SHA256 contract (t=/v1= over `${timestamp}.${rawBody}`, 300s tolerance), the raw-body requirement that breaks most first attempts, replay protection, and the response rules that keep an unauthenticated caller from learning why verification failed.
---

# FurlPay webhooks

A webhook endpoint is an unauthenticated, internet-facing route that moves money in
your system. Treat it as hostile input until the signature verifies.

## The contract

FurlPay signs every delivery with `furlpay-signature`:

```
furlpay-signature: t=1755993600,v1=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
```

- `t` — Unix seconds when FurlPay signed the payload.
- `v1` — `HMAC-SHA256(secret, "${t}.${rawBody}")`, hex.

Signed value is `${t}.${rawBody}` — the timestamp, a literal `.`, then the **exact
bytes** of the request body. Verified against `furlpay-node/src/webhooks.ts`.

**Tolerance is 300 seconds.** A delivery whose `t` is more than 5 minutes from your
clock is rejected as a replay. Clock skew on your server is therefore a real cause of
"signature verification failed" — check NTP before suspecting the secret.

## Step 1 — Preserve the raw body

**This is what breaks most first attempts.** JSON body parsers re-serialise, and
re-serialised JSON is not byte-identical: key order, whitespace and unicode escaping
all shift. The HMAC is over bytes, so any reserialisation fails verification with a
correct secret.

Register the webhook route **before** the JSON parser, with a raw-body parser:

```js
// Express — order matters. This route must come BEFORE app.use(express.json()).
app.post("/webhooks", express.raw({ type: "application/json" }), (req, res) => { … });
app.use(express.json()); // everything else
```

Next.js App Router reads the raw body explicitly:

```ts
export async function POST(req: Request) {
  const raw = await req.text();               // NOT req.json()
  const sig = req.headers.get("furlpay-signature");
  // …verify over `raw`, parse only after
}
```

Fastify needs `addContentTypeParser` to keep the buffer. Django needs
`request.body`, not `request.POST`. In every framework the rule is the same: get the
bytes, not the parsed object.

## Step 2 — Verify before parsing

Use the SDK when the language has one:

```js
const { Furlpay } = require("@furlpay/furlpay-node");

let event;
try {
  event = Furlpay.webhooks.constructEvent(
    req.body,                                  // raw Buffer
    req.headers["furlpay-signature"],
    process.env.FURLPAY_ENDPOINT_SECRET
  );
} catch (err) {
  console.error("Webhook signature verification failed:", err.message);
  return res.status(400).json({ error: "invalid_signature" });
}
```

`constructEvent` runs `JSON.parse` **only after** the HMAC check passes. Preserve that
order in any hand-rolled implementation: parsing attacker-controlled JSON before
authenticating it hands an unauthenticated caller your parser.

Hand-rolled verification, when no SDK exists:

```ts
import crypto from "node:crypto";

function verify(rawBody: string, header: string, secret: string): boolean {
  const parts = Object.fromEntries(header.split(",").map(kv => kv.split("=").map(s => s.trim())));
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(parts.t)) > 300) return false;

  const expected = crypto.createHmac("sha256", secret).update(`${parts.t}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1);
  // Length check FIRST: timingSafeEqual throws on a length mismatch.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

Use `timingSafeEqual`, never `===`. A byte-by-byte comparison leaks how much of a
forged signature was correct, which is enough to recover one over many attempts.

## Step 3 — Respond without leaking

Return a flat failure. Do **not** echo the error:

```js
return res.status(400).json({ error: "invalid_signature" });   // correct
return res.status(400).send(`Webhook Error: ${err.message}`);  // two bugs
```

The second line is wrong twice. Express's `send(string)` sets
`Content-Type: text/html`, making any request-derived text in that message a
reflected-XSS sink. And distinguishing "malformed header" from "bad signature" hands
an unauthenticated caller a probe for tuning their next attempt.

Return **200 quickly**. Do the work asynchronously — FurlPay retries on non-2xx, so a
slow handler becomes a duplicate handler.

## Step 4 — Make delivery idempotent

At-least-once delivery is the contract. The same `event.id` will arrive twice: on
retry after a timeout, and after a network blip where your 200 never landed.

Key on `event.id` and claim it atomically before acting:

```ts
const claimed = await redis.set(`webhook:${event.id}`, "1", { nx: true, ex: 86400 });
if (!claimed) return res.status(200).json({ received: true }); // already handled
```

Claim **before** the side effect, not after. A dedupe check that runs after you have
already credited a balance has not prevented anything.

## Event types

`payment.settled` · `payment.failed` · `payment.refunded` ·
`card.transaction.created` · `booking.confirmed` · `booking.failed` ·
`kyc.updated`

Handle unknown types by ignoring them and returning 200. New event types ship without
notice, and a 500 on an unrecognised type turns a feature launch into a retry storm
against your endpoint.

## Debugging "signature verification failed"

Work down this list — it is ordered by how often each is the actual cause:

1. **Body was parsed before verification.** By far the most common. Log
   `typeof req.body` — a plain object means the raw bytes are already gone.
2. **Clock skew.** Compare `t` in the header against your server clock. Beyond 300s
   the delivery is rejected even with the right secret.
3. **Wrong secret.** Endpoint secrets are per-endpoint. A staging secret against a
   production endpoint fails exactly like a forged signature.
4. **A proxy rewrote the body.** Some gateways re-encode or strip charset. Verify at
   the edge, or ensure the body passes through untouched.
5. **Header duplicated.** Take the first value; do not join them.

## Security rules

- Never log the endpoint secret, and never echo it in an error.
- Fail closed when `FURLPAY_ENDPOINT_SECRET` is unset. An endpoint that skips
  verification because a variable is missing accepts forged events from anyone.
- Never trust amounts or recipients from the event body alone for anything
  irreversible — read them back from the API before shipping goods.
