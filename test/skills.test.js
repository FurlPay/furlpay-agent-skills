// Skill-format and content invariants.
//
// A skill is a document, so the usual "does it run" test does not apply. What CAN
// regress is the format an agent host parses (a malformed frontmatter block means the
// skill silently never loads) and the specific contract values copied out of the
// FurlPay source. Those values are the whole reason to prefer a skill over the API
// reference, and a stale one is worse than no skill: an agent will follow it
// confidently.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = path.join(root, "skills");
const skills = fs.readdirSync(skillsDir);

/** Minimal frontmatter reader — the same shape an agent host parses. */
function frontmatter(file) {
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(raw.startsWith("---\n"), `${file}: must open with a --- frontmatter block`);
  const end = raw.indexOf("\n---\n", 4);
  assert.ok(end !== -1, `${file}: unterminated frontmatter`);
  const block = raw.slice(4, end);
  const out = {};
  let key = null;
  for (const line of block.split("\n")) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (m) { key = m[1]; out[key] = m[2]; }
    else if (key && line.trim()) out[key] += " " + line.trim();
  }
  return { meta: out, body: raw.slice(end + 5) };
}

test("every skill directory has a SKILL.md", () => {
  for (const s of skills) {
    assert.ok(fs.existsSync(path.join(skillsDir, s, "SKILL.md")), `${s}: missing SKILL.md`);
  }
});

for (const s of skills) {
  const file = path.join(skillsDir, s, "SKILL.md");

  test(`${s}: frontmatter is well formed`, () => {
    const { meta } = frontmatter(file);
    assert.equal(meta.name, s, "`name` must equal the directory name or the host cannot resolve it");
    assert.ok(meta.description, "missing description");
  });

  test(`${s}: description is specific enough to be selected correctly`, () => {
    const { meta } = frontmatter(file);
    // The description is the ONLY thing most hosts use to decide whether to load a
    // skill. Too short and it is never selected; with no trigger language it is
    // selected at the wrong moments.
    assert.ok(meta.description.length >= 120, `description too short (${meta.description.length} chars)`);
    assert.ok(meta.description.length <= 1024, `description too long (${meta.description.length} chars)`);
    assert.match(meta.description, /\bUse (this |this skill |it )?when\b/i, "should say when to use it");
  });

  test(`${s}: body has content beyond the frontmatter`, () => {
    const { body } = frontmatter(file);
    assert.ok(body.trim().length > 400, "body is too thin to be useful");
    assert.match(body, /^# /m, "should open with an H1");
  });
}

// ── Contract values copied out of the FurlPay source ──────────────────────────
// If one of these changes upstream, the skill starts teaching agents something
// false. These assertions are the tripwire.

test("webhooks skill states the verified 300s tolerance", () => {
  const { body } = frontmatter(path.join(skillsDir, "furlpay-webhooks", "SKILL.md"));
  // furlpay-node/src/webhooks.ts: const TOLERANCE_SECONDS = 300;
  assert.match(body, /300 seconds|300s/, "tolerance must be stated");
  assert.match(body, /\$\{t\}\.\$\{rawBody\}|\$\{timestamp\}\.\$\{rawBody\}/, "signing string must be stated exactly");
  assert.match(body, /timingSafeEqual/, "must require constant-time comparison");
});

test("webhooks skill leads with the raw-body requirement", () => {
  const { body } = frontmatter(path.join(skillsDir, "furlpay-webhooks", "SKILL.md"));
  const rawBodyAt = body.indexOf("raw body");
  const eventTypesAt = body.indexOf("## Event types");
  assert.ok(rawBodyAt !== -1 && rawBodyAt < eventTypesAt, "raw-body handling must come before the reference material");
});

test("webhooks skill shows the XSS sink only as a labelled counter-example", () => {
  const { body } = frontmatter(path.join(skillsDir, "furlpay-webhooks", "SKILL.md"));
  // `res.send(string)` sets text/html, so interpolating error text into it is a
  // reflected-XSS sink. It may appear ONCE, on a line marked wrong, so an agent
  // learns to recognise it — never as the recommended form.
  const lines = body.split("\n");
  const sinkLines = lines.filter((l) => /res\.status\(400\)\.send\(/.test(l));
  assert.equal(sinkLines.length, 1, "the sink should appear exactly once, as the counter-example");
  assert.match(sinkLines[0], /two bugs|wrong/i, "the sink line must be annotated as wrong");

  const goodLines = lines.filter((l) => /res\.status\(400\)\.json\(/.test(l));
  assert.ok(goodLines.length >= 1, "the safe JSON response must be shown");
  assert.match(goodLines.find((l) => /correct/.test(l)) ?? "", /correct/, "the JSON form must be marked correct");
  assert.match(body, /invalid_signature/, "must show the flat failure response");
});

test("x402 skill states the dual claim and the no-release rule", () => {
  const { body } = frontmatter(path.join(skillsDir, "furlpay-x402", "SKILL.md"));
  assert.match(body, /nonce/i);
  assert.match(body, /quoteId|quote/i);
  assert.match(body, /SET NX/, "atomic claim mechanism must be named");
  assert.match(body, /must NOT release the claim|keeping it burned|stays burned/i,
    "the failed-settlement rule must be stated — releasing the claim reopens the replay window");
});

test("x402 skill does not tell agents to migrate v1 headers away", () => {
  const { body } = frontmatter(path.join(skillsDir, "furlpay-x402", "SKILL.md"));
  // FurlPay serves both dialects deliberately; replacing X-PAYMENT breaks v1 clients.
  assert.match(body, /Do \*\*not\*\* "migrate"|Emit both/i, "must warn against dropping v1");
  assert.match(body, /PAYMENT-SIGNATURE/);
  assert.match(body, /X-PAYMENT/);
});

test("get-started skill carries the non-negotiable integration rules", () => {
  const { body } = frontmatter(path.join(skillsDir, "furlpay-get-started", "SKILL.md"));
  for (const rule of [/idempotenc/i, /rate.?limit/i, /randomUUID/, /NEXT_PUBLIC_/, /fail closed/i]) {
    assert.match(body, rule, `missing rule: ${rule}`);
  }
});

test("auth skill states the single-writer rule for u.security", () => {
  const { body } = frontmatter(path.join(skillsDir, "furlpay-auth", "SKILL.md"));
  // AGENTS.md rule 4: u.security holds totpSecret and is writable only through
  // /api/security/mfa. A skill that omits this teaches mass assignment by silence.
  assert.match(body, /u\.security/, "must name the object");
  assert.match(body, /\/api\/security\/mfa/, "must name the only endpoint that may write it");
  assert.match(body, /totpSecret/, "must say what is at stake");
  // services/payments.ts: FURLPAY_HITL_THRESHOLD_USD || 3000
  assert.match(body, /\$3,?000|3000/, "step-up threshold must be stated");
  assert.match(body, /httpOnly/, "session storage guidance must be present");
});

test("payments skill refuses float money and states the verified fee", () => {
  const { body } = frontmatter(path.join(skillsDir, "furlpay-payments", "SKILL.md"));
  assert.match(body, /bigint|BigInt/, "must require integer atomic units");
  assert.match(body, /0\.30000000000000004|never a float|not a float/i, "must show why floats fail");
  // services/payments.ts:26 — export const FEE_RATE = 0.005;
  assert.match(body, /0\.5%/, "the 0.5% platform fee must be stated");
  assert.match(body, /Idempotency-Key/, "idempotency header must be shown");
  assert.match(body, /record.*before.*submit|record the payment as `created`/i,
    "record-before-submit ordering must be stated");
});

test("wallet skill forbids lowercasing base58 and requires pairwise validation", () => {
  const { body } = frontmatter(path.join(skillsDir, "furlpay-wallet", "SKILL.md"));
  // Base58 is case-sensitive; lowercasing a Solana address corrupts it and can
  // collide two distinct addresses. This is the trap the skill exists to close.
  assert.match(body, /[Nn]ever lowercase a Solana address/, "must forbid lowercasing base58");
  assert.match(body, /new PublicKey\(/, "must require a real base58 decode, not a regex");
  assert.match(body, /isValidForChainKind/, "must name the address-to-chain check");
  assert.match(body, /findAssociatedTokenPda/, "must cover ATA derivation");
  assert.match(body, /derived|ledger is right/i, "balances must be described as derived");
});

test("cards skill keeps PAN off the server and freezes before persisting", () => {
  const { body } = frontmatter(path.join(skillsDir, "furlpay-cards", "SKILL.md"));
  assert.match(body, /never touch your server|never hold/i, "must exclude PAN/CVV from the server");
  assert.match(body, /PCI/, "must explain the scope consequence");
  assert.match(body, /in-memory state flips immediately|Apply locally, then persist/i,
    "freeze must take effect before the durable write");
  assert.match(body, /3DS2/, "must cover the challenge flow");
  assert.match(body, /single-use/, "challenges must be single-use");
});

test("travel skill binds the quote chain and claims before the supplier call", () => {
  const { body } = frontmatter(path.join(skillsDir, "furlpay-travel", "SKILL.md"));
  assert.match(body, /quoteId/, "booking must reference a server-issued quote");
  assert.match(body, /nx: true|atomically before/i, "must claim before the external call");
  assert.match(body, /before calling the supplier|before the external call/i,
    "claim ordering must be explicit — a claim after the call prevents nothing");
  assert.match(body, /FurlPayEscrow/, "must name the escrow contract");
  assert.match(body, /indeterminate/i, "must model the unknown supplier outcome");
  assert.match(body, /travel_book/, "must separate reading from spending in MCP tools");
});

test("every skill leads with a failure mode, not the happy path", () => {
  // The house style: a model already guesses the happy path correctly. The value
  // of a skill is the part where a plausible implementation is a wrong one.
  const signals = /never|must not|wrong|breaks|fails|trap|mistake|do not|refuses|hostile|cannot/i;
  for (const s of skills) {
    const { body } = frontmatter(path.join(skillsDir, s, "SKILL.md"));
    const opening = body.slice(0, 1600);
    assert.match(opening, signals, `${s}: opens without naming a failure mode`);
  }
});

test("no skill leaks a credential-shaped literal", () => {
  for (const s of skills) {
    const raw = fs.readFileSync(path.join(skillsDir, s, "SKILL.md"), "utf8");
    assert.ok(!/sk_live_[A-Za-z0-9]{8,}/.test(raw), `${s}: live-key-shaped literal`);
    assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(raw), `${s}: private key block`);
    // Env vars must be shown empty, never with a plausible value assigned.
    assert.ok(!/FURLPAY_API_KEY=[A-Za-z0-9]{8,}/.test(raw), `${s}: API key with a value`);
  }
});

test("plugin manifests are valid and consistent", () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8"));
  const market = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "marketplace.json"), "utf8"));
  assert.ok(plugin.name && plugin.version && plugin.description);
  assert.equal(market.plugins[0].name, plugin.name, "marketplace must reference the plugin by name");
});
