# CT Elementor Builder Skill

## Status

**CANDIDATE — not yet approved.** Seeded in `src/data/seed.ts` (`SKILL_IDS.ELEMENTOR_BUILDER =
"skill_ct_elementor_builder"`) with `status: "CANDIDATE"`, "foundation only" per CTOS-003. It shows up
in the `/knowledge` Skills panel's CANDIDATE tab but is excluded from every execution context until a
human approves it (`approvedSkillsForAgent()` returns `APPROVED` skills only — see
`docs/SKILL-SYSTEM.md`). Agent 05 (WordPress / Elementor Builder) is seeded with `instructionPackIds:
[SKILL_IDS.ELEMENTOR_BUILDER]`, so approval alone is enough to activate it in Agent 05's context — no
other code change needed.

## Metadata

```
id       skill_ct_elementor_builder
name     "CT Elementor Builder Skill v0.1"
version  1
kind     build_practice
scope    "build-practice"
owner    Agent 05 — WordPress / Elementor Builder
reviewer Agent 06 — QA & Launch Auditor
```

`evidence`: "U-Proof Elementor build — global Site Kit usage", "U-Proof structured write verification
practice."

## Content (verbatim, from `src/data/seed.ts`)

Validated WordPress/Elementor implementation practice, foundation only:

* Build with native Elementor containers/widgets first — avoid giant custom HTML blobs; keep
  construction editable-first so a human can adjust it in the editor afterward.
* Use the global Site Kit (colours, type, spacing) rather than per-page overrides; scope custom CSS
  narrowly and use custom JS only when a native option genuinely does not exist.
* Any structured Elementor write (via the REST/DB layer) must be re-read and parsed immediately after
  writing, to confirm it saved as intended, not assumed from a 200 response.
* Take a backup before any material mutation; `wp_slash` semantics differ between WP metadata APIs and
  raw DB writes — treat raw DB writes as a narrow fallback only, never the default path.
* Verify Elementor page/template CSS actually propagated (not just that the save call succeeded);
  browser render validation is required — HTTP 200 is not visual QA.
* Validate with real CDP viewport emulation at 1440/1254/1024/768/480/375; check shared header/footer
  consistency across templates.
* The builder never certifies its own final visual quality (Agent 03/06 do, via the CT Visual Design
  Skill); all work stays isolated from production until a human approves it, and every risky change
  has a stated rollback plan before it is made.

## Why it's separate from the CT Visual Design Skill

This skill governs **implementation practice** (how Elementor/WordPress structure is built and
verified); the CT Visual Design Skill (see `docs/CT-VISUAL-DESIGN-SKILL.md`) governs the **finished
visual verdict**. Agent 05's own `exclusions` in `src/data/seed.ts` are explicit: "Never certifies its
own visual quality (Agent 03/06 do)" and "Never activates a launch itself" — implementation and
sign-off stay separate roles, exactly as this skill's content states in its final bullet.

Every U-Proof lesson this skill draws on traces to real evidence already in the seed history: the
global Site Kit build practice (CT-UP-003/003A) and the structured-write-verification and
`wp_slash`/raw-DB-fallback lessons that also appear, independently, as `wordpress`-category
`AgentLesson` candidates in `docs/INTELLIGENCE-MODEL.md`'s U-Proof lesson table. The two systems
(`KnowledgeItem`/`AgentLesson` and `Skill`) were populated from the same real history but remain
separate records — see `docs/SKILL-SYSTEM.md` for why.
