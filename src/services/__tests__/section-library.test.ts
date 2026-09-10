import { describe, it, expect } from "vitest";
import {
  SECTION_LIBRARY_DEFAULTS,
  SECTION_LIBRARY_IDS,
  selectBuildStrategy,
  NoveltyGovernanceError,
  validateNoveltyJustification,
  addSectionLibraryEntry,
  approveSectionEntry,
  activeSections,
  approvedSections,
} from "../section-library";
import type { OSData, SectionLibraryEntry } from "@/data/types";
import { EMPTY } from "@/gateway/core";

const baseData = (): OSData => ({ ...EMPTY, sectionLibrary: [...SECTION_LIBRARY_DEFAULTS] });

// ---------------------------------------------------------------------------
// SECTION_LIBRARY_DEFAULTS
// ---------------------------------------------------------------------------
describe("SECTION_LIBRARY_DEFAULTS", () => {
  it("contains exactly 15 entries", () => {
    expect(SECTION_LIBRARY_DEFAULTS).toHaveLength(15);
  });

  it("all entries are CANDIDATE status", () => {
    for (const entry of SECTION_LIBRARY_DEFAULTS) {
      expect(entry.status).toBe("CANDIDATE");
    }
  });

  it("all entries use LIBRARY_ASSEMBLY strategy", () => {
    for (const entry of SECTION_LIBRARY_DEFAULTS) {
      expect(entry.buildStrategy).toBe("LIBRARY_ASSEMBLY");
    }
  });

  it("all entries have stable IDs", () => {
    const ids = SECTION_LIBRARY_DEFAULTS.map((e) => e.id);
    expect(ids).toContain(SECTION_LIBRARY_IDS.HERO_STANDARD);
    expect(ids).toContain(SECTION_LIBRARY_IDS.FOOTER_STANDARD);
    expect(ids).toContain(SECTION_LIBRARY_IDS.PRODUCT_GRID);
  });

  it("has no duplicate IDs", () => {
    const ids = SECTION_LIBRARY_DEFAULTS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// selectBuildStrategy
// ---------------------------------------------------------------------------
describe("selectBuildStrategy", () => {
  it("returns LIBRARY_ASSEMBLY for a known section name", () => {
    const { strategy, matchedEntry } = selectBuildStrategy("Hero — Standard", SECTION_LIBRARY_DEFAULTS);
    expect(strategy).toBe("LIBRARY_ASSEMBLY");
    expect(matchedEntry).not.toBeNull();
    expect(matchedEntry!.id).toBe(SECTION_LIBRARY_IDS.HERO_STANDARD);
  });

  it("returns NATIVE_NOVEL_BUILD for unknown section name", () => {
    const { strategy, matchedEntry } = selectBuildStrategy("Bespoke Animated Intro", SECTION_LIBRARY_DEFAULTS);
    expect(strategy).toBe("NATIVE_NOVEL_BUILD");
    expect(matchedEntry).toBeNull();
  });

  it("is case-insensitive for matching", () => {
    const { strategy } = selectBuildStrategy("hero — standard", SECTION_LIBRARY_DEFAULTS);
    expect(strategy).toBe("LIBRARY_ASSEMBLY");
  });

  it("does not match DEPRECATED entries", () => {
    const deprecated = SECTION_LIBRARY_DEFAULTS.map((e) => ({ ...e, status: "DEPRECATED" as const }));
    const { strategy } = selectBuildStrategy("Hero — Standard", deprecated);
    expect(strategy).toBe("NATIVE_NOVEL_BUILD");
  });
});

// ---------------------------------------------------------------------------
// validateNoveltyJustification
// ---------------------------------------------------------------------------
describe("validateNoveltyJustification", () => {
  it("passes for LIBRARY_ASSEMBLY without justification", () => {
    const entry: SectionLibraryEntry = {
      id: "s1", name: "Hero", description: "Hero", category: "hero",
      status: "CANDIDATE", buildStrategy: "LIBRARY_ASSEMBLY",
      evidence: [], approvedBy: null, approvedAt: null, createdAt: null,
    };
    expect(() => validateNoveltyJustification(entry)).not.toThrow();
  });

  it("throws for NATIVE_NOVEL_BUILD with no justification", () => {
    const entry: SectionLibraryEntry = {
      id: "s1", name: "Custom Widget", description: "Custom Widget", category: "custom",
      status: "CANDIDATE", buildStrategy: "NATIVE_NOVEL_BUILD",
      evidence: [], approvedBy: null, approvedAt: null, createdAt: null,
    };
    expect(() => validateNoveltyJustification(entry)).toThrow(NoveltyGovernanceError);
  });

  it("throws for NATIVE_NOVEL_BUILD with too-short justification", () => {
    const entry: SectionLibraryEntry = {
      id: "s1", name: "Custom Widget", description: "Custom", category: "custom",
      status: "CANDIDATE", buildStrategy: "NATIVE_NOVEL_BUILD",
      noveltyJustification: "short",
      evidence: [], approvedBy: null, approvedAt: null, createdAt: null,
    };
    expect(() => validateNoveltyJustification(entry)).toThrow(NoveltyGovernanceError);
  });

  it("passes for NATIVE_NOVEL_BUILD with adequate justification", () => {
    const entry: SectionLibraryEntry = {
      id: "s1", name: "Animated Timeline", description: "Custom animated timeline", category: "custom",
      status: "CANDIDATE", buildStrategy: "NATIVE_NOVEL_BUILD",
      noveltyJustification: "No library pattern supports animated vertical timelines with branching.",
      evidence: [], approvedBy: null, approvedAt: null, createdAt: null,
    };
    expect(() => validateNoveltyJustification(entry)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// addSectionLibraryEntry / approveSectionEntry
// ---------------------------------------------------------------------------
describe("addSectionLibraryEntry", () => {
  it("adds a new entry to the library", () => {
    const data = baseData();
    const newEntry: SectionLibraryEntry = {
      id: "slib_custom", name: "Custom Section", description: "Custom", category: "custom",
      status: "CANDIDATE", buildStrategy: "NATIVE_NOVEL_BUILD",
      noveltyJustification: "No matching pattern exists in the current library — unique animated reveal.",
      evidence: [], approvedBy: null, approvedAt: null, createdAt: null,
    };
    const { data: updated, entry } = addSectionLibraryEntry(data, newEntry);
    expect(updated.sectionLibrary).toHaveLength(data.sectionLibrary.length + 1);
    expect(entry.id).toBe("slib_custom");
  });
});

describe("approveSectionEntry", () => {
  it("promotes a CANDIDATE entry to APPROVED", () => {
    const data = baseData();
    const { data: updated } = approveSectionEntry(data, SECTION_LIBRARY_IDS.HERO_STANDARD, "Richard", "2024-06-01T00:00:00Z");
    const entry = updated.sectionLibrary.find((e) => e.id === SECTION_LIBRARY_IDS.HERO_STANDARD);
    expect(entry!.status).toBe("APPROVED");
    expect(entry!.approvedBy).toBe("Richard");
  });

  it("throws when entry is not found", () => {
    expect(() => approveSectionEntry(baseData(), "nonexistent", "Richard", "2024-01-01T00:00:00Z")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// activeSections / approvedSections
// ---------------------------------------------------------------------------
describe("activeSections", () => {
  it("returns CANDIDATE and APPROVED entries", () => {
    const data = baseData();
    const active = activeSections(data);
    expect(active.length).toBeGreaterThan(0);
    for (const e of active) {
      expect(["CANDIDATE", "APPROVED"]).toContain(e.status);
    }
  });
});

describe("approvedSections", () => {
  it("returns empty when all entries are CANDIDATE", () => {
    const data = baseData();
    expect(approvedSections(data)).toHaveLength(0);
  });

  it("returns only APPROVED entries after approval", () => {
    const data = baseData();
    const { data: updated } = approveSectionEntry(data, SECTION_LIBRARY_IDS.HERO_STANDARD, "Richard", "2024-06-01T00:00:00Z");
    const approved = approvedSections(updated);
    expect(approved).toHaveLength(1);
    expect(approved[0]!.status).toBe("APPROVED");
  });
});
