# FurlPay Agent Skills

Procedural integration knowledge for AI coding agents — Claude Code, Cursor, Codex,
Copilot, Windsurf, and any MCP-aware client.

API reference tells an agent *what* endpoints exist. It does not tell it that the
webhook route must be registered before the JSON parser, or that a failed x402
settlement must **not** release the replay claim. Those are the things that decide
whether a generated integration is correct, and they are exactly what gets lost when
a developer delegates integration to a model.

These skills encode them.

## Skills

| Skill | Covers |
|---|---|
| `furlpay-get-started` | Package selection, env config, mock vs live, the rules every integration must hold |
| `furlpay-auth` | WebAuthn passkeys, rpID across web/native/extension, session cookies, step-up above $3,000 |
| `furlpay-payments` | Gasless ERC-4337 transfers, Solana Actions, atomic-unit arithmetic, idempotency, record-before-submit |
| `furlpay-wallet` | Per-chain address validation, address-to-network binding, Solana ATA derivation, derived balances |
| `furlpay-cards` | PAN exclusion and PCI scope, instant freeze, velocity limits, 3DS2 challenge resolution |
| `furlpay-travel` | Time-locked escrow, the quote-to-booking identity chain, one-payment-one-booking, MCP tool safety |
| `furlpay-webhooks` | HMAC-SHA256 contract, the raw-body requirement, replay protection, safe failure responses |
| `furlpay-x402` | The 402 handshake, EIP-3009 off-chain authorization, dual atomic claim, confirmation depth, v1/v2 dialects |

## Install

**Claude Code** — add the marketplace, then install:

```bash
/plugin marketplace add FurlPay/furlpay-agent-skills
/plugin install furlpay-skills
```

**Any agent** — the skills are plain Markdown with YAML frontmatter. Copy the
`skills/` directory into wherever your tool reads skills from (`.agents/skills/`,
`.cursor/rules/`, or your own loader). There is no runtime and nothing to execute.

## What these are not

They do not execute anything, hold credentials, or make network calls. They are
documents. An agent reads one and writes better code; nothing here runs.

They also do not replace the API reference. They cover the parts where a plausible
implementation is a wrong one.

## Why the content is shaped this way

Each skill leads with the failure mode rather than the happy path, because the happy
path is the part a model already guesses correctly. `furlpay-webhooks` opens with raw
bodies because re-serialised JSON breaks HMAC verification and the resulting error —
"signature verification failed" — points at the secret instead of the parser, which
is where the hour goes.

Every contract stated here was verified against the FurlPay source rather than
transcribed from documentation: the 300-second webhook tolerance, the `${t}.${rawBody}`
signing string, the dual nonce/quote claim, the v1/v2 header split.

## Contributing

A skill is wrong if an agent following it produces an integration that fails. If you
hit that, open an issue with the prompt and the generated code — that is a more
useful bug report than a diff.

MIT.
