# CT Visual Design Skill

## Status

**CANDIDATE — not yet approved.** Seeded in `src/data/seed.ts` (`SKILL_IDS.VISUAL_DESIGN =
"skill_ct_visual_design"`) with `status: "CANDIDATE"`, per CTOS-003's own framing: "foundation only —
do NOT mark it permanent Agency doctrine." It is reviewable in the `/knowledge` Skills panel
(CANDIDATE tab) but is **excluded from every execution context** until a human approves it —
`approvedSkillsForAgent()` only ever returns `APPROVED` skills (see `docs/SKILL-SYSTEM.md`). Agent 03
(Creative Director) is seeded with `instructionPackIds: [SKILL_IDS.VISUAL_DESIGN]`, so the moment this
skill is approved it starts appearing in Agent 03's "ACTIVE SKILLS" system-prompt block with no other
code change.

## Metadata

```
id       skill_ct_visual_design
name     "CT Visual Design Skill v0.1"
version  1
kind     design_review
scope    "design-review"
owner    Agent 03 — Creative Director
reviewer Agent 06 — QA & Launch Auditor
```

`evidence`: "U-Proof visual QA passes — desktop/tablet/mobile screenshot review", "U-Proof product
card legibility fixes."

## Rubric (verbatim content, from `src/data/seed.ts`)

A structured, client-readiness review, scored per category, **never self-certified by the builder**.
Eleven categories:

1. **Brand consistency** — logo/colour/type used correctly and consistently.
2. **Hierarchy** — the eye is led to the primary action on every page.
3. **Spacing** — consistent rhythm, no cramped or wildly uneven gaps.
4. **Typography** — a small, consistent type scale, no orphaned styles.
5. **Navigation** — desktop and mobile nav are complete, uncluttered, and every link resolves.
6. **Responsiveness** — desktop/tablet/mobile screenshots reviewed at real breakpoints; no clipped
   text, no overlap.
7. **Conversion clarity** — the primary CTA is unambiguous per page.
8. **Content clarity** — no placeholder/lorem text, no inconsistent shared components.
9. **Product presentation** — product cards are legible, images are relevant and correctly cropped.
10. **Trust/professionalism** — the page would not embarrass the agency in front of the client.
11. **Technical visual defects** — no clipped text, no visible internal scaffolding, no broken shared
    components.

## Verdict scale

Each category is scored individually, then a single client-readiness verdict is given:

| Verdict | Meaning |
|---|---|
| **A** | SAFE TO SEND |
| **B** | SMALL POLISH PASS (list exactly what) |
| **C** | NOT READY (list why) |

Design quality is judged separately from technical correctness — the skill's content is explicit that
a page can be functionally correct (HTTP 200, no console errors) and still fail this review.

## Why it's separate from the CT Elementor Builder Skill

This skill judges the **finished visual result**; the Elementor Builder Skill (see
`docs/CT-ELEMENTOR-BUILDER-SKILL.md`) governs **how the build is constructed**. Agent 03 owns this
one and never self-certifies its own visual QA verdict on someone else's build — Agent 06 reviews, per
Agent 03's `exclusions` in `src/data/seed.ts`: `"Never self-certifies its own visual QA verdict on
someone else's build (Agent 06 reviews)"`.
