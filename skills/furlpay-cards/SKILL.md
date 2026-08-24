---
name: furlpay-cards
description: Work with FurlPay virtual and physical cards — issuing, spend controls and velocity limits, freezing a card, and resolving 3DS2 step-up challenges from a push notification or the browser extension. Use when a developer is building card management UI, handling a card authorization webhook, implementing freeze, adding spending limits, or wiring the 3DS2 challenge inbox. Covers why a freeze must take effect before the write is durable, and the card data that must never reach your server.
---

# FurlPay cards

A card is a spending instrument attached to a stablecoin balance. Authorizations
arrive from the network in real time and must be answered in **milliseconds** — the
timing constraint shapes every design decision here.

## Card data you must never hold

Full PAN, CVV and magnetic-stripe data never touch your server. Render card details
through FurlPay's UI components, which display them in an isolated context your page
cannot read.

Handling raw card data puts your entire server in PCI-DSS scope. Not touching it is
the control — nothing else is as effective, and no amount of care substitutes.

What you may store and display: **last four digits**, network, expiry month/year,
card state. That is enough for every legitimate UI.

## Freeze must be instant, and instant means in-memory first

Freeze is the control a user reaches for when they think something is wrong. It has
to take effect **before** the state is durably written, because the next
authorization may arrive in the same second.

```
user taps Freeze
    ↓
in-memory state flips immediately   ← authorizations decline from here
    ↓
durable write
    ↓
propagate to the issuer
```

A freeze that waits for a database round-trip is a freeze with a window in it, and
that window is exactly when the fraud is happening. Apply locally, then persist —
and if the durable write fails, keep the card frozen and surface the error. Failing
back to *unfrozen* because a write failed inverts the safety property.

Freeze is reversible and user-initiated; **it does not need a confirmation dialog**.
Unfreezing does.

## Spend controls

Limits belong on the server. A limit enforced only in the UI is a suggestion:

- **per-transaction** — a ceiling on any single authorization
- **velocity** — amount per rolling window (daily, monthly)
- **merchant category (MCC)** — an allowlist, not a blocklist. Blocklists fail open
  on categories you have not thought of; allowlists fail closed.
- **geography** — where the card may be presented

Evaluate every limit **before** approving the authorization, and evaluate them
against the amount actually requested, not a client-supplied figure.

Watch the sign on amounts. A negative amount can turn a spend into a credit if the
handler subtracts without validating — schemas give money `.positive()` and an upper
bound for exactly this reason.

## 3DS2 challenges

When an issuer requires step-up on an online purchase, the challenge has to reach the
cardholder and come back **inside the authorization window**. FurlPay surfaces it on
two surfaces at once:

```
issuer requires 3DS2
    ↓
challenge lands in the pending inbox
    ↓
push notification  ──┐
browser extension  ──┴──→ user approves (biometric)
    ↓
result returns to the issuer before the window closes
```

Poll the inbox rather than assuming push arrives — push is best-effort and a dropped
notification becomes a declined purchase at a checkout the user is standing at. The
extension polls, which is why it can approve a challenge the phone missed.

**Bind the approval to the challenge.** An approval that only proves "a human was
present" can be harvested on one challenge and replayed on another. The biometric
assertion must carry the challenge id, the amount and the merchant.

**A challenge is single-use and expires.** Claim it atomically on approval — two
devices answering the same challenge must resolve to one outcome, not two.

## Authorization webhooks

Card authorization webhooks are the tightest deadline in the product. Verify the HMAC
signature (see `furlpay-webhooks`), decide, respond. Everything else — notifications,
analytics, ledger detail — happens after the response.

Fail **closed** when the endpoint secret is unset. An authorization handler that
approves because it could not verify the signature approves anything that reaches
the URL.

## Security rules

- Never log a PAN, CVV, or full authorization payload. Log the card id and last four.
- Never return full card data from an API, including to the cardholder.
- Enforce every limit server-side; treat client-supplied limits as display only.
- Rate-limit card mutations per user — freeze/unfreeze toggled in a loop is abuse.
- Require step-up for issuing a new card or raising a limit. Both expand spending
  authority, and a stolen session should not be able to do either.
