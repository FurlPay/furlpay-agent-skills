---
name: furlpay-auth
description: Implement FurlPay authentication — WebAuthn passkey registration and assertion, session cookies, and step-up authentication before high-value transactions. Use when a developer is adding sign-in or sign-up, debugging a failed passkey assertion, deciding where to store a session, asking how to gate a large transfer behind a second factor, or touching anything that reads or writes MFA state. Covers the rpID rules that break passkeys across native apps and extensions, and the one object that must never be written from a general endpoint.
---

# FurlPay authentication

Passkeys are the primary factor. There is no password to phish, reuse or leak — a
passkey is a keypair bound to an origin, and the private half never leaves the
authenticator.

## Step 1 — Registration and assertion

Two ceremonies, both server-initiated:

```
register:  server issues challenge → authenticator creates keypair → server stores public key
sign in:   server issues challenge → authenticator signs it → server verifies against stored key
```

The server issues the challenge in both cases. A client-generated challenge is not a
challenge — it removes the replay protection the ceremony exists to provide.

Every challenge must be **single-use and time-bounded**. Store it against the pending
ceremony, burn it on verification, and expire it. A challenge that can be replayed is
a signature that can be replayed.

## Step 2 — rpID is where passkeys break

The relying-party ID binds a passkey to an origin. Get it wrong and registration
succeeds while assertion silently fails on another surface — the confusing case,
because nothing looks broken until a user tries to sign in from somewhere else.

- **Web** — `rpID` is the registrable domain (`furlpay.com`), not the full URL and
  not a subdomain unless you intend to scope it there.
- **Native Android** — the app asserts through an `android:apk-key-hash` origin
  derived from the **signing certificate**. Play App Signing re-signs your upload, so
  the fingerprint that ends up on devices is Play's, not your local keystore's.
  Registering the wrong one produces an app that cannot use passkeys at all, and the
  failure appears only after release.
- **Browser extension** — Chrome 122+ lets a listed extension ID assert a site's
  passkey. That widens the signing surface deliberately; the ID must be explicit.

Configuration lives in `FURLPAY_RP_ID`, `FURLPAY_ORIGIN`,
`FURLPAY_ANDROID_CERT_SHA256`, `FURLPAY_EXTENSION_ID`.

## Step 3 — Sessions

The session lives in an **HttpOnly cookie**, never in `localStorage`. JavaScript
cannot read an HttpOnly cookie, so an XSS bug cannot exfiltrate the session — with
`localStorage`, any script on the page can.

FurlPay's cookie flags:

```ts
{ httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" }
```

`sameSite: "lax"` blocks the cross-site POST that CSRF depends on while still
allowing top-level navigation into the app. `secure` is conditional only so local
HTTP development works; in production it is always on.

Verify the session **inside every route**, not only in middleware. Middleware can
answer "is there a valid session" but not "may this session do this" — it does not
know which role or ownership a given route requires. A route that skips its own check
because middleware exists is a route with no authorization.

## Step 4 — Step-up before large transactions

A valid session is not sufficient authority for an arbitrary amount. Above a
threshold, re-authenticate for **that specific action**:

```
transfer $50    → session is enough
transfer $5,000 → step-up: fresh passkey assertion bound to this transfer
```

FurlPay's compliance threshold is `FURLPAY_HITL_THRESHOLD_USD`, **defaulting to
$3,000**. At or above it the payment is held for human review rather than settled
(`amount_over_threshold_$3000`).

Bind the step-up assertion to the transaction — amount, recipient, asset. An
assertion that only proves "a human was present" can be harvested during one action
and spent on another.

## The rule that has no exceptions

**`u.security` is written by exactly one endpoint: `/api/security/mfa`.**

It holds `totpSecret`. Any other route that merges client JSON into the user object
can be made to overwrite it — that is mass assignment, and here it rewrites the
second factor. Whitelist fields explicitly on every update path:

```ts
// wrong — a client can set any field, including security
Object.assign(user, await req.json());

// right — only what this endpoint owns
const { name, phone } = ProfileSchema.parse(await req.json());
user.name = name;
user.phone = phone;
```

And it never comes back out. `totpSecret`, private keys, session secrets and full PII
are stripped from every response, including the GET that returns the user's own
profile. "The user already knows their own secret" is not a reason to serialise it
into a response that proxies, logs and error trackers will see.

## Security rules

- Rate-limit auth endpoints hard. They are unauthenticated by definition and are
  where credential stuffing lands.
- Fail closed when `FURLPAY_SESSION_SECRET` is unset — never fall back to a default.
- Do not disclose whether an account exists. "Invalid credentials" for both cases;
  a distinguishable error is an account-enumeration oracle.
- Use `crypto.randomUUID()` / `crypto.getRandomValues()` for challenges and session
  ids. `Math.random()` is predictable and must never generate either.
