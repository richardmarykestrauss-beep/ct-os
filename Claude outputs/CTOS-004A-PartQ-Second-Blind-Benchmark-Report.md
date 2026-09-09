# CTOS-004A Part Q — Second Blind Benchmark: Final Report

**Date:** 2026-09-09
**Scope:** Real 7-stage CT-OS pipeline execution (Agent 01→06 + Orchestrator) run twice — once on U-Proof (known, existing project) and once on Imvusa Furniture (genuinely blind, unseen project) — plus a cross-site evaluation. All execution went through CT-OS's actual production gateway code (`createServerRegistry` → `ModelRouter.execute` → `buildExecutionRequest`/`toProviderRequest`), calling the real Gemini and Anthropic APIs. No stubs, no simulation.

---

## 1. U-Proof Stages 4–7 Status

All four remaining stages completed for real after the Gemini quota pause was lifted.

| Stage | Agent | Status | Notes |
|---|---|---|---|
| 4 — SEO & Content | A04 | ✅ Complete | Succeeded on 3rd invocation (see §3) |
| 5 — Builder Plan | A05 | ✅ Complete | Read-only plan only; Gemini never attempted (lacks `code` capability) |
| 6 — QA & Launch Audit | A06 | ✅ Complete | Genuinely independent — found 3×P1, 4×P2, 1×P3 defects |
| 7 — Orchestrator synthesis | ORCH | ✅ Complete | `agent_benchmark_report@1` frozen; succeeded on 2nd invocation |

Combined with Stages 1–3 (completed earlier, all via Gemini), **U-Proof's full 7-stage known-benchmark run is complete and frozen.**

## 2. Provider Used Per Stage

| Stage | Provider | Model | In / Out tokens |
|---|---|---|---|
| U1 Research | Gemini | gemini-3.6-flash | 4,025 / 1,481 |
| U2 UX | Gemini | gemini-3.6-flash | 3,297 / 1,938 |
| U3 Creative | Gemini | gemini-3.6-flash | 4,629 / 1,251 |
| U4 SEO | **Claude (fallback)** | claude-sonnet-5 | 9,700 / 5,566 |
| U5 Builder Plan | **Claude (capability-routed)** | claude-sonnet-5 | 10,226 / 7,689 |
| U6 QA | **Claude (fallback)** | claude-sonnet-5 | 15,296 / 3,052 |
| U7 Orchestrator | **Claude (fallback)** | claude-sonnet-5 | 19,998 / 8,279 |
| I1 Research | **Claude (fallback)** | claude-sonnet-5 | 3,625 / 3,127 |
| I2 UX | **Claude (fallback)** | claude-sonnet-5 | 4,564 / 3,755 |
| I3 Creative | **Claude (fallback)** | claude-sonnet-5 | 6,810 / 2,907 |
| I4 SEO | **Claude (fallback)** | claude-sonnet-5 | 9,108 / 4,955 |
| I5 Builder Plan | **Claude (capability-routed)** | claude-sonnet-5 | 9,387 / 6,608 |
| I6 QA | Claude (Claude-only mode) | claude-sonnet-5 | 14,416 / 2,463 |
| I7 Orchestrator | Claude (Claude-only mode) | claude-sonnet-5 | 18,709 / 7,205 |
| X8 Cross-site eval | Claude (Claude-only mode) | claude-sonnet-5 | 13,575 / 5,573 |

U1–U3 are the only stages Gemini actually executed. Every other stage — 12 of 15 — was carried by Claude, either as a genuine fallback after a live Gemini failure, or (Stages 5/U5, I5) because Gemini's adapter doesn't declare the `code` capability A05 requires, or (I6, I7, X8) because Gemini was deliberately taken out of the routing policy partway through at your instruction.

## 3. Gemini Failures / Claude Fallbacks

**Gemini quota exhaustion (real, unresolved for the rest of the session):** starting partway through U4, every Gemini attempt returned `HTTP 429 quota exceeded`. This never recovered despite the earlier pause for you to check Google AI Studio billing — the 429s continued through I4. At your instruction, I then removed Gemini from the routing policy entirely for I6/I7/X8 (`preferredProvider: "claude"`, no fallback) to stop wasting time on calls that were certain to fail.

**Stages that needed more than one real invocation to succeed, and why (all genuine, no simulated failures):**

- **U4 (SEO):** 3 invocations. 1st: Gemini 429 + Claude 404 ("model not found" — the adapter's hardcoded default Claude model, `claude-3-5-sonnet-20241022`, is retired; fixed by setting `ANTHROPIC_MODEL=claude-sonnet-5`, confirmed against Anthropic's real `/v1/models` list). 2nd: Gemini 503 + Claude succeeded but *failed schema validation* — truncated at the adapter's hardcoded 4,096-token output cap. Fixed by raising the default (see §12). 3rd: Gemini 503 + Claude succeeded cleanly.
- **U7 (Orchestrator):** 2 invocations. 1st: Gemini 429 + Claude failed schema validation (a genuine, non-truncation content_pack shape defect, described below). 2nd: succeeded.
- **I1 (Research):** **5 invocations.** Gemini 429 on every attempt. Claude failed schema validation 4 times running — and inspecting the raw failed output showed the actual defect: Claude's forced tool-use call was emitting literal `<parameter name="...">value</parameter>` XML tags *as the string content* of the `businessContext` field, instead of clean JSON array values. This is a real, reproducible Claude output-formatting defect, not a code bug in CT-OS's request-building — the tool's JSON schema was correctly constructed each time (verified in `src/schemas/artifacts.ts`'s `jsonSchemaFor`). Adding an explicit "do not emit XML-style `<parameter>` tags" instruction to the job resolved it, and the 5th invocation succeeded cleanly. I carried this same instruction into every subsequent stage's prompt as a precaution.
- **I4 (SEO):** 2 invocations. 1st: I mis-specified A04's `requiredCapabilities` (used `"seo"` instead of the real `"long_context"` from `seed.ts`), so *both* providers were skipped by the router as missing a declared capability — a real router-correctness finding, not a provider bug. Fixed and re-run; 2nd invocation: Gemini 429 + Claude succeeded.
- **X8 (Cross-site evaluation):** 3 invocations. 1st: Claude failed validation (missing `trustRecommendation`), and its own output flagged that the two input reports had been truncated in its context. Investigating confirmed a real defect: `claude.ts`'s prompt-builder hard-truncates any input artifact's embedded JSON to 6,000 characters, and both frozen benchmark reports exceed that. Raised to 40,000 characters and re-ran. 2nd invocation: Claude failed validation again (missing `dimensions` — the same XML/malformed-tool-call pattern as I1). 3rd invocation: succeeded, now against the **full, untruncated** U-Proof and Imvusa reports.

All other stages (U1–U3, U5, U6, I2, I3, I5, I6, I7) succeeded on their first real invocation.

## 4. Token Usage

Summed across the 15 successful final calls above: **≈213,200 tokens** (input + output). This does not include tokens consumed by the failed retries in §3 — those add meaningfully more (the U4/U7/I1/X8 failed Claude attempts alone consumed roughly another 60–70K tokens across their failed outputs, plus every Gemini 429 attempt, though those return no billable content). Total real spend across this whole segment is materially higher than the successful-call total alone.

## 5. U-Proof Benchmark Report (agent_benchmark_report@1 — frozen)

**Business understanding:** correctly identified U-Proof as a South African waterproofing/building-products manufacturer (owner Martin), site being completed after a prior developer handover failure, real VAT-inclusive ZAR pricing, and the client's preference for live Fastway shipping + Payflex/card payment over manual EFT. Correctly used prior Creative Touch audit history as legitimate known context (listed explicitly in `knownContextUsed`).

**Real strengths found:** correct variation pricing already built for several lines; prior security hardening; Stage 4 content honestly flagged the shop-catalog issue as unverified rather than claiming it fixed; build_plan correctly excluded RED-tier actions from scope; the three fake placeholder Help & Advice articles were replaced with real commissioned content.

**Real weaknesses found:** shop page still only renders 1 of 5 categories live; homepage Application/product links still use `#` placeholders; Contact-page address (Vereeniging) still conflicts with the WooCommerce shipping-origin address (Edenvale); a placeholder phone number remains alongside the real one; featured-card pricing still shows the wrong Fibre Filler price (R500 vs real R1590) and missing Bonding Liquid Primer prices; the "recent articles" teaser still links to placeholder future-dated posts; DNS still not cut over to uproof.co.za; shipping/payment gateways still lack live credentials; order-notification emails still misrouted.

**QA's independent challenge (Stage 6, real defects, not rubber-stamped):** 3×P1 — content_pack overstating fixed status beyond its own caveat; build_plan not visibly ticketing the address/shipping-origin conflict; build_plan not visibly ticketing the order-notification misconfiguration. 4×P2 — missing tickets for blog cleanup, builder-engine (Elementor vs 10Web) re-verification, partial artifact-visibility limiting full coverage confirmation, and no explicit human visual sign-off gate before activation.

## 6. Known Issues Rediscovered

Every major issue present in U-Proof's real prior Creative Touch audit history was independently rediscovered and cited with evidence somewhere in this 7-stage run: the shop-catalog rendering bug, the wrong Fibre Filler price, the address discrepancy, the placeholder phone number, the dead `#` links, the fake blog teasers, the Elementor-vs-10Web builder-engine mismatch, the order-notification email misconfiguration, and the 10Web trial-domain asset hardcoding. None of these had to be reintroduced by me — the pipeline surfaced all of them from the real evidence and known context supplied.

## 7. Known Issues Missed

**U-Proof:** I did not find a clear instance of a previously-known issue being completely dropped and never mentioned at any stage across the 7-stage run — I want to flag honestly that I did not perform an exhaustive line-by-line diff of the full prior-audit knowledge item against every stage's output, so absence of evidence here isn't full proof of completeness, but nothing turned up missing in the review I did.

**Imvusa (more telling, since this is the blind run):** Stage 1's research explicitly flagged the inline image CAPTCHA/accessibility concern. Stages 2 through 5 (blueprint, design system, content, build plan) then **silently dropped it** — it appears nowhere in the intermediate artifacts. It was only caught and reinstated by Stage 6 QA, which flagged it as a real defect ("a silently-dropped issue requiring explicit re-ticketing") and it made it into the final frozen report's `unsupportedAssumptionsRejected`. This is a genuine, observed instance of the pipeline nearly losing a real finding mid-chain, caught only because QA did its job — which is exactly the kind of failure mode Stage 6 exists to catch, and here it worked.

## 8. False Positives

No confirmed false positives in either report — every flagged finding carries real evidence and an appropriate confidence score. The two closest candidates are both cases where the pipeline itself already hedged correctly rather than overclaiming: the Imvusa CAPTCHA finding was explicitly labeled "a minor observation, not a confirmed defect" by the research agent (it may simply be an artifact of how a picture-CAPTCHA widget's alt-text gets swept into extracted page text, not a real accessibility failure — needs a human visual check to confirm either way); and U-Proof's Elementor-vs-10Web builder-engine discrepancy was flagged as needing verification, not asserted as a confirmed problem.

## 9. Imvusa Pipeline Status

All 7 stages completed for real, genuinely blind (doctrine-only knowledge, zero U-Proof or other-project contamination — confirmed: the Imvusa knowledge file contains only the 4 approved DOCTRINE items, no PROJECT-scoped items at all).

| Stage | Agent | Status |
|---|---|---|
| 1 — Research | A01 | ✅ Complete (5 invocations — see §3) |
| 2 — UX | A02 | ✅ Complete |
| 3 — Creative | A03 | ✅ Complete |
| 4 — SEO & Content | A04 | ✅ Complete (2 invocations — see §3) |
| 5 — Builder Plan | A05 | ✅ Complete, read-only |
| 6 — QA | A06 | ✅ Complete |
| 7 — Orchestrator | ORCH | ✅ Complete; `blind_benchmark_report@1` frozen |

Real evidence for imvusa.net was gathered via a live rendered browser session (WebFetch could not reach the site — persistent `robots.txt` fetch failure, unrelated to CT-OS), covering the home, services, leather-couches, gallery, and contact-us pages.

## 10. Imvusa Findings (blind_benchmark_report@1 — frozen)

**Business understanding:** correctly identified as a real South African custom furniture/reupholstery/interior-services business (George and Bloemfontein), a lead-generation/consultation model, not ecommerce — correctly did *not* try to force a shop/cart journey onto it.

**Real strengths found:** clear value-proposition copy; genuine two-location presence; correctly treated the absence of shop/pricing pages as appropriate rather than a defect; named a real fabric-supplier partnership and specific collections as usable content; not all contact data is broken (emails and the Bloemfontein phone are consistent).

**Real weaknesses found, all independently discovered with no prior audit to lean on:**
- **George office phone number differs** between the homepage (082 468 8898) and Contact Us page (051 430 9883) — a real, directly-observed conflict I verified myself via live browser navigation before handing it to the pipeline as evidence.
- **Bloemfontein office address differs** between the homepage ("15A Kraal Street, Old East End") and Contact Us page ("6 Alpha Straat, Ou Oos Einde") — likewise directly observed.
- The entire 8-item services list is duplicated back-to-back on the Services page.
- The fabric supplier's name is spelled two different ways ("Hertext Fabrics" vs "Hertex") on the same page.
- Leather Couches and Gallery pages are almost entirely image-based with minimal indexable text.
- An inline image CAPTCHA appears as plain extracted text near both contact blocks (flagged, then dropped, then recovered by QA — see §7).

**Build plan correctly refused to guess:** it created two explicit AMBER-gated, blocked tickets for the phone/address conflicts rather than picking one value — deferring to human/client confirmation, exactly the doctrine-correct behavior.

**QA's independent challenge (Stage 6):** caught the dropped CAPTCHA finding; challenged whether the "single canonical contact block" claim was actually verified given both content_pack and build_plan were only supplied to QA in truncated form; challenged whether the net-new pages (Get a Quote, About, Fabrics & Collections, location subpages) were actually approved scope or just assumed; reaffirmed the two contact-data conflicts remain a real P0 launch-blocking gap.

## 11. Cross-Site Agent Evaluation (cross_site_agent_evaluation@1)

Run against the **full, untruncated** versions of both frozen reports (see §3/X8).

| Dimension | Verdict |
|---|---|
| Independent discovery quality | Imvusa is the stronger evidence — it had no prior-history crutch and still surfaced hard, specific, verifiable conflicts |
| Generic vs. site-specific | Parity — both runs produced concrete, non-transferable specifics (real numbers, addresses, page names) |
| Hallucinations | None detected in either run |
| Implementation specificity | Parity — both plans are ticket-level specific with correct RED/AMBER discipline |
| Visual reasoning quality | Parity, slight edge to Imvusa — both honestly disclosed the total absence of real vision input |
| SEO reasoning quality | Parity — each correctly reasoned about its own business model (ecommerce vs lead-gen) |
| QA challenge quality | Parity with different strengths — U-Proof's QA stronger on internal-consistency detection, Imvusa's QA stronger on omission-detection (the dropped CAPTCHA finding) |

**Trust recommendation: TRUST_WITH_CONDITIONS.** The pipeline reasons well, stays evidence-grounded, doesn't hallucinate, and self-corrects (QA genuinely catches real defects) in both a knowledge-rich and a genuinely blind run — meaningful positive signal. But: (1) this run mostly tested Claude-only behavior, not the intended Gemini-preferred/Claude-fallback design, since Gemini's quota never recovered; (2) Claude's fallback path had real, only-just-patched defects (XML-tag leakage, undersized token cap, input-truncation) that a human caught by reviewing logs, not that the pipeline self-detected; (3) visual reasoning remains completely unvalidated — both runs assessed only the *honesty* of disclosing no vision input, never actual visual competence.

**Explicit conditions before unconditional trust:** re-run with both providers healthy end-to-end at least once; fix the Claude adapter defects at the code level (not per-job prompt patches); require Stage 6 QA to always produce an itemized defect list so its rigor is verifiable rather than inferred; never treat visual/design claims as verified until real screenshots are supplied and re-analyzed; keep all human approval gates (PREVIEW/QA/FINAL REGRESSION/LAUNCH) mandatory regardless of benchmark score.

## 12. Router / Continuity Verdict

**Yes — the Gemini→Claude fallback (and, separately, Gemini→Claude routing for capability-restricted jobs) worked correctly without changing agent identity or breaking the artifact chain.** Every stage's `AgentJob.agentId` and the agent's code/role/permissions stayed fixed regardless of which provider actually executed it; `ModelRouter`'s `attempts` array transparently recorded every provider tried, why, and what happened (visible throughout this report). Downstream stages consumed upstream artifacts identically whether the artifact had been produced by Gemini or Claude — the artifact schema and content shape is provider-agnostic by design, and this held up in practice across 15 real stage executions.

That said, this segment surfaced three real infrastructure defects in the process (all fixed, uncommitted, on disk now):
1. `src/ai/providers/claude.ts` hardcoded a stale default model (`claude-3-5-sonnet-20241022`, since retired) — no env-driven fallback existed to catch this. Set `ANTHROPIC_MODEL=claude-sonnet-5` in `.env.local`.
2. `ClaudeProvider`'s default output-token cap was hardcoded at 4,096 with no environment override, while `GeminiProvider` sets no cap at all — a real asymmetry that silently truncated valid large artifacts. Raised the default to 16,000 in code.
3. `claude.ts`'s prompt-builder truncated any input artifact's embedded content to 6,000 characters — too small for the benchmark's own summary reports. Raised to 40,000 in code.

None of these changes are committed (per your instruction). They're real, working fixes sitting in the working tree — `git status` shows exactly these three files modified, nothing else.

## 13. Zero-Mutation Proof

- No website login, no authentication, of any kind, against either uproof.co.za/its Hostinger staging domain or imvusa.net.
- No POST/PUT/PATCH/DELETE request was made to either site. All evidence gathering was read-only: WebFetch (U-Proof, earlier in the engagement) and real Chrome browser navigation + text extraction (Imvusa, this segment — WebFetch itself could not reach imvusa.net due to a persistent robots.txt fetch failure on their end). CAPTCHAs encountered on Imvusa were never interacted with or solved.
- No DNS, hosting, WooCommerce, or plugin action of any kind was taken.
- No database write of any kind (Supabase was never touched — this entire benchmark ran outside it, per the earlier architectural decision to script the gateway directly).
- `git log` confirms no new commits were created this session — HEAD is still at the pre-session tip (`a0025db`). `git status --porcelain` shows only the 3 modified source files (§12) and the new `benchmark-runs/`/`scripts/benchmark/` scratch directories — nothing staged, nothing committed.
- `.env.local` (holding both real API keys) remains gitignored and untracked throughout.
- `npx tsc --noEmit` and `npx vitest run` both pass clean (202/202 tests) after all changes.

## 14. Safe to Begin Controlled Website Writes: **NO — not yet.**

The pipeline's reasoning quality is genuinely good and this benchmark is a positive signal, but I can't respond "yes" honestly given what actually happened operationally:

- Almost the entire benchmark ran on a single provider (Claude alone) because Gemini's quota never recovered — the Gemini-preferred/Claude-fallback design this ticket asked to validate was only exercised for 3 of 15 stages.
- Claude's own path needed three separate real-code defects fixed *during* this run (stale model, undersized token cap, undersized input-truncation) before it could complete reliably, plus a 5-attempt struggle on Stage 1 of the blind run against a real tool-call formatting defect (XML-tag leakage) that a human had to diagnose from raw output — the pipeline had no self-detection or self-repair for any of this.
- Visual reasoning is completely unvalidated — every design_system output in both runs is an honestly-disclosed guess, never checked against a real screenshot.
- QA's own rigor, while real in both runs, was not measured identically (Imvusa's QA challenge came through more clearly than a formally comparable itemized list would have made verifiable).

The cross-site evaluation's own verdict — TRUST_WITH_CONDITIONS, not TRUST — matches my own assessment independently. The conditions listed in §11 are the concrete bar to clear before this pipeline should touch a third live client unattended.

---

*All work products from this benchmark — knowledge files, stage inputs/outputs, run scripts, both frozen reports, and this final report — remain on disk under `benchmark-runs/` and `scripts/benchmark/` in the repo working tree, uncommitted, exactly as this ticket required.*
