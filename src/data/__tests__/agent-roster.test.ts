/**
 * Agent roster validation tests (CTOS-005A Final Pass + Roster Cleanup).
 *
 * Validates:
 *  - All agent IDs are stable (00–08 preserved)
 *  - Agent names match the permanent operational identities
 *  - Critical ownership boundaries are explicit in responsibilities/role
 *  - A06 owns QA only — does NOT own or execute launch
 *  - A07 owns launch/infrastructure preparation — does NOT autonomously execute RED actions
 *  - A08 is event-triggered/scheduled, not continuously autonomous
 */
import { describe, it, expect } from "vitest";
import { seedData, AGENT_IDS } from "../seed";

const agents = seedData.agents;

function findAgent(id: string) {
  const a = agents.find((ag) => ag.id === id);
  if (!a) throw new Error(`Agent ${id} not found in seedData`);
  return a;
}

function agentText(id: string): string {
  const a = findAgent(id);
  return [
    a.name,
    a.role,
    ...(a.responsibilities ?? []),
    a.mission ?? "",
    ...(a.exclusions ?? []),
  ].join(" ");
}

// ---------------------------------------------------------------------------
// ID stability
// ---------------------------------------------------------------------------

describe("Agent IDs — stable roster (00–08 preserved)", () => {
  it("ORCH ID is agent_orch", () => {
    expect(AGENT_IDS.ORCH).toBe("agent_orch");
  });

  it("A01 ID is agent_01", () => {
    expect(AGENT_IDS.A01).toBe("agent_01");
  });

  it("A06 ID is agent_06", () => {
    expect(AGENT_IDS.A06).toBe("agent_06");
  });

  it("A08 ID is agent_08", () => {
    expect(AGENT_IDS.A08).toBe("agent_08");
  });

  it("all nine agents exist in seedData", () => {
    expect(agents.length).toBeGreaterThanOrEqual(9);
    for (const id of Object.values(AGENT_IDS)) {
      expect(agents.some((a) => a.id === id)).toBe(true);
    }
  });

  it("agent codes are sequential A01–A08 plus ORCH", () => {
    const codes = agents.map((a) => a.code).sort();
    for (const code of ["A01", "A02", "A03", "A04", "A05", "A06", "A07", "A08", "ORCH"]) {
      expect(codes).toContain(code);
    }
  });
});

// ---------------------------------------------------------------------------
// Permanent operational names
// ---------------------------------------------------------------------------

describe("Permanent operational names", () => {
  it("ORCH = Conductor", () => {
    expect(findAgent(AGENT_IDS.ORCH).name).toBe("Conductor");
  });

  it("A01 = Discovery", () => {
    expect(findAgent(AGENT_IDS.A01).name).toBe("Discovery");
  });

  it("A02 = Site Architect", () => {
    expect(findAgent(AGENT_IDS.A02).name).toBe("Site Architect");
  });

  it("A03 = Creative Director", () => {
    expect(findAgent(AGENT_IDS.A03).name).toBe("Creative Director");
  });

  it("A04 = Content", () => {
    expect(findAgent(AGENT_IDS.A04).name).toBe("Content");
  });

  it("A05 = Builder", () => {
    expect(findAgent(AGENT_IDS.A05).name).toBe("Builder");
  });

  it("A06 = QA", () => {
    expect(findAgent(AGENT_IDS.A06).name).toBe("QA");
  });

  it("A07 = Launch & Infrastructure", () => {
    expect(findAgent(AGENT_IDS.A07).name).toBe("Launch & Infrastructure");
  });

  it("A08 = Curator", () => {
    expect(findAgent(AGENT_IDS.A08).name).toBe("Curator");
  });
});

// ---------------------------------------------------------------------------
// A02 — Site Architect ownership
// ---------------------------------------------------------------------------

describe("A02 — Site Architect ownership", () => {
  it("owns sitemap and site architecture", () => {
    expect(agentText(AGENT_IDS.A02).toLowerCase()).toMatch(/sitemap/);
  });

  it("owns UX and journeys", () => {
    expect(agentText(AGENT_IDS.A02).toLowerCase()).toMatch(/ux|journey/);
  });

  it("owns keyword-to-page strategy", () => {
    expect(agentText(AGENT_IDS.A02).toLowerCase()).toMatch(/keyword/);
  });

  it("owns catalogue/ecommerce architecture", () => {
    expect(agentText(AGENT_IDS.A02).toLowerCase()).toMatch(/catalogue|ecommerce/);
  });

  it("owns conversion architecture", () => {
    expect(agentText(AGENT_IDS.A02).toLowerCase()).toMatch(/conversion/);
  });

  it("owns navigation structure", () => {
    expect(agentText(AGENT_IDS.A02).toLowerCase()).toMatch(/navigation/);
  });
});

// ---------------------------------------------------------------------------
// A03 — Creative Director passes
// ---------------------------------------------------------------------------

describe("A03 — Creative Director operating passes", () => {
  it("explicitly mentions DIRECTION pass", () => {
    expect(agentText(AGENT_IDS.A03)).toMatch(/DIRECTION/);
  });

  it("explicitly mentions COMPOSITION pass", () => {
    expect(agentText(AGENT_IDS.A03)).toMatch(/COMPOSITION/);
  });

  it("explicitly mentions VISUAL_REVIEW pass", () => {
    expect(agentText(AGENT_IDS.A03)).toMatch(/VISUAL_REVIEW/);
  });

  it("VISUAL_REVIEW requires real screenshots", () => {
    expect(agentText(AGENT_IDS.A03).toLowerCase()).toMatch(/screenshot/);
  });
});

// ---------------------------------------------------------------------------
// A04 — Content ownership (not broad SEO strategy)
// ---------------------------------------------------------------------------

describe("A04 — Content ownership", () => {
  it("owns copy", () => {
    expect(agentText(AGENT_IDS.A04).toLowerCase()).toMatch(/copy/);
  });

  it("owns metadata", () => {
    expect(agentText(AGENT_IDS.A04).toLowerCase()).toMatch(/metadata/);
  });

  it("owns alt text", () => {
    expect(agentText(AGENT_IDS.A04).toLowerCase()).toMatch(/alt text/);
  });

  it("owns internal linking", () => {
    expect(agentText(AGENT_IDS.A04).toLowerCase()).toMatch(/internal link/);
  });

  it("owns brand voice", () => {
    expect(agentText(AGENT_IDS.A04).toLowerCase()).toMatch(/brand voice/);
  });
});

// ---------------------------------------------------------------------------
// A06 — QA boundary (QA only; does NOT own or execute launch)
// ---------------------------------------------------------------------------

describe("A06 — QA owns QA only", () => {
  it("covers technical QA", () => {
    expect(agentText(AGENT_IDS.A06).toLowerCase()).toMatch(/technical qa/);
  });

  it("covers visual QA", () => {
    expect(agentText(AGENT_IDS.A06).toLowerCase()).toMatch(/visual qa/);
  });

  it("covers responsive QA", () => {
    expect(agentText(AGENT_IDS.A06).toLowerCase()).toMatch(/responsive qa/);
  });

  it("covers journey QA", () => {
    expect(agentText(AGENT_IDS.A06).toLowerCase()).toMatch(/journey qa/);
  });

  it("covers content QA", () => {
    expect(agentText(AGENT_IDS.A06).toLowerCase()).toMatch(/content qa/);
  });

  it("covers SEO QA", () => {
    expect(agentText(AGENT_IDS.A06).toLowerCase()).toMatch(/seo qa/);
  });

  it("covers launch-readiness evidence/audit", () => {
    expect(agentText(AGENT_IDS.A06).toLowerCase()).toMatch(/launch.readiness/);
  });

  it("covers defect detection and severity", () => {
    expect(agentText(AGENT_IDS.A06).toLowerCase()).toMatch(/defect|severity/);
  });

  it("explicitly excludes owning or executing launch", () => {
    const exclusions = (findAgent(AGENT_IDS.A06).exclusions ?? []).join(" ").toLowerCase();
    expect(exclusions).toMatch(/launch/);
    expect(exclusions).toMatch(/executes|approves/);
  });

  it("cannot execute site changes", () => {
    expect(findAgent(AGENT_IDS.A06).canExecuteSiteChanges).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A07 — Launch & Infrastructure
// ---------------------------------------------------------------------------

describe("A07 — Launch & Infrastructure ownership", () => {
  it("owns launch runbook", () => {
    expect(agentText(AGENT_IDS.A07).toLowerCase()).toMatch(/launch runbook/);
  });

  it("owns infrastructure verification", () => {
    expect(agentText(AGENT_IDS.A07).toLowerCase()).toMatch(/infrastructure/);
  });

  it("owns migration and preflight preparation", () => {
    expect(agentText(AGENT_IDS.A07).toLowerCase()).toMatch(/migration|preflight/);
  });

  it("owns backup and rollback readiness", () => {
    expect(agentText(AGENT_IDS.A07).toLowerCase()).toMatch(/backup|rollback/);
  });

  it("owns post-launch verification", () => {
    expect(agentText(AGENT_IDS.A07).toLowerCase()).toMatch(/post.launch/);
  });

  it("explicitly excludes autonomous RED actions", () => {
    const exclusions = (findAgent(AGENT_IDS.A07).exclusions ?? []).join(" ").toLowerCase();
    expect(exclusions).toMatch(/red/);
    expect(exclusions).toMatch(/autonomously/);
  });
});

// ---------------------------------------------------------------------------
// A08 — Curator (event-triggered/scheduled, not continuous)
// ---------------------------------------------------------------------------

describe("A08 — Curator is event-triggered/scheduled", () => {
  it("is modelled as event-triggered or scheduled", () => {
    expect(agentText(AGENT_IDS.A08).toLowerCase()).toMatch(/event.triggered|scheduled/);
  });

  it("explicitly excludes continuous autonomous running", () => {
    expect(agentText(AGENT_IDS.A08).toLowerCase()).toMatch(/continuous|autonomously/);
  });

  it("cannot execute site changes", () => {
    expect(findAgent(AGENT_IDS.A08).canExecuteSiteChanges).toBe(false);
  });
});
