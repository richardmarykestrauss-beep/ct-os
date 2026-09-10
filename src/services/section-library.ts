/**
 * Section Library (CTOS-005B Parts 11–13).
 *
 * - Part 11: SectionLibraryEntry data model + CANDIDATE starter patterns.
 * - Part 12: LIBRARY_ASSEMBLY vs NATIVE_NOVEL_BUILD strategy selection.
 * - Part 13: Section novelty governance — requires justification for NATIVE_NOVEL_BUILD.
 *
 * All functions are pure. No OSData writes.
 */
import type { BuildStrategy, ISODate, OSData, SectionLibraryEntry, SectionLibraryStatus } from "@/data/types";

// ---------------------------------------------------------------------------
// Part 11 — Starter section library (CANDIDATE patterns)
// ---------------------------------------------------------------------------

/** Stable IDs for seeded section library entries. */
export const SECTION_LIBRARY_IDS = {
  HERO_STANDARD: "slib_hero_standard",
  HERO_SPLIT: "slib_hero_split",
  FEATURE_3COL: "slib_feature_3col",
  FEATURE_2COL: "slib_feature_2col",
  CTA_BANNER: "slib_cta_banner",
  TESTIMONIALS_ROW: "slib_testimonials_row",
  PRODUCT_GRID: "slib_product_grid",
  PRODUCT_CARD: "slib_product_card",
  CONTACT_FORM: "slib_contact_form",
  HEADER_STANDARD: "slib_header_standard",
  FOOTER_STANDARD: "slib_footer_standard",
  BREADCRUMB: "slib_breadcrumb",
  ACCORDION_FAQ: "slib_accordion_faq",
  IMAGE_TEXT_ROW: "slib_image_text_row",
  CONTENT_RICHTEXT: "slib_content_richtext",
} as const;

function candidate(
  id: string,
  name: string,
  description: string,
  category: string,
  evidence: string[] = [],
): SectionLibraryEntry {
  return {
    id,
    name,
    description,
    category,
    status: "CANDIDATE",
    buildStrategy: "LIBRARY_ASSEMBLY",
    evidence,
    approvedBy: null,
    approvedAt: null,
    createdAt: null,
  };
}

/** Default CANDIDATE section library patterns seeded with CT-OS (CTOS-005B Part 11). */
export const SECTION_LIBRARY_DEFAULTS: SectionLibraryEntry[] = [
  candidate(SECTION_LIBRARY_IDS.HERO_STANDARD, "Hero — Standard", "Full-width hero: H1 + subtext + single CTA, image right or background", "hero", ["U-Proof homepage hero"]),
  candidate(SECTION_LIBRARY_IDS.HERO_SPLIT, "Hero — Split", "50/50 hero: headline + CTA left, image right (no background)", "hero"),
  candidate(SECTION_LIBRARY_IDS.FEATURE_3COL, "Feature Row — 3 Column", "3-column icon/image + heading + body + optional CTA per card", "content", ["U-Proof solutions row"]),
  candidate(SECTION_LIBRARY_IDS.FEATURE_2COL, "Feature Row — 2 Column", "2-column feature/comparison row", "content"),
  candidate(SECTION_LIBRARY_IDS.CTA_BANNER, "CTA Banner", "Full-width or contained CTA strip: short headline + button", "conversion", ["U-Proof contact CTA"]),
  candidate(SECTION_LIBRARY_IDS.TESTIMONIALS_ROW, "Testimonials Row", "1–3 testimonial cards with quote, name and optional role/company", "trust"),
  candidate(SECTION_LIBRARY_IDS.PRODUCT_GRID, "Product Grid (WooCommerce)", "WooCommerce product archive grid — standard card layout", "ecommerce", ["U-Proof Product Archive template 292"]),
  candidate(SECTION_LIBRARY_IDS.PRODUCT_CARD, "Product Card (WooCommerce)", "Single WooCommerce product card — image + title + price + CTA", "ecommerce", ["U-Proof Single Product template 293"]),
  candidate(SECTION_LIBRARY_IDS.CONTACT_FORM, "Contact Form", "Contact form with name, email, message; optional phone", "forms"),
  candidate(SECTION_LIBRARY_IDS.HEADER_STANDARD, "Header — Standard", "Logo left; main nav; optional CTA button; hamburger on mobile", "layout", ["U-Proof header"]),
  candidate(SECTION_LIBRARY_IDS.FOOTER_STANDARD, "Footer — Standard", "Logo; secondary nav; contact details; copyright; legal links", "layout", ["U-Proof footer"]),
  candidate(SECTION_LIBRARY_IDS.BREADCRUMB, "Breadcrumb", "Standard breadcrumb trail for interior pages", "navigation"),
  candidate(SECTION_LIBRARY_IDS.ACCORDION_FAQ, "Accordion / FAQ", "Expand-collapse FAQ or content accordion", "content"),
  candidate(SECTION_LIBRARY_IDS.IMAGE_TEXT_ROW, "Image + Text Row", "Alternating image/text rows with optional CTA", "content"),
  candidate(SECTION_LIBRARY_IDS.CONTENT_RICHTEXT, "Rich Text Content Block", "Full-width or contained WYSIWYG content block", "content"),
];

// ---------------------------------------------------------------------------
// Part 12 — Strategy selection (LIBRARY_ASSEMBLY vs NATIVE_NOVEL_BUILD)
// ---------------------------------------------------------------------------

/**
 * Select the build strategy for a section by name.
 * If the name (case-insensitive) matches a CANDIDATE/APPROVED library entry, prefer LIBRARY_ASSEMBLY.
 * Otherwise the caller must use NATIVE_NOVEL_BUILD and supply a justification.
 */
export function selectBuildStrategy(sectionName: string, library: SectionLibraryEntry[]): { strategy: BuildStrategy; matchedEntry: SectionLibraryEntry | null } {
  const lower = sectionName.toLowerCase();
  const active = library.filter((e) => e.status === "CANDIDATE" || e.status === "APPROVED");
  const match = active.find((e) => e.name.toLowerCase() === lower || lower.includes(e.name.toLowerCase().split("—")[0]!.trim()));
  return match ? { strategy: "LIBRARY_ASSEMBLY", matchedEntry: match } : { strategy: "NATIVE_NOVEL_BUILD", matchedEntry: null };
}

// ---------------------------------------------------------------------------
// Part 13 — Novelty governance
// ---------------------------------------------------------------------------

export class NoveltyGovernanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoveltyGovernanceError";
  }
}

/**
 * Validate that a NATIVE_NOVEL_BUILD decision is justified.
 * Throws NoveltyGovernanceError when justification is absent or too short.
 */
export function validateNoveltyJustification(entry: SectionLibraryEntry): void {
  if (entry.buildStrategy !== "NATIVE_NOVEL_BUILD") return;
  if (!entry.noveltyJustification || entry.noveltyJustification.trim().length < 20) {
    throw new NoveltyGovernanceError(
      `Section "${entry.name}" uses NATIVE_NOVEL_BUILD but has no justification (or justification is too short). ` +
        "Provide a reason why no existing library entry is suitable.",
    );
  }
}

/** Filter section library entries to approved-only (APPROVED) for production use. */
export function approvedSections(data: OSData): SectionLibraryEntry[] {
  return data.sectionLibrary.filter((e) => e.status === "APPROVED");
}

/** Filter to CANDIDATE + APPROVED entries (available for strategy selection). */
export function activeSections(data: OSData): SectionLibraryEntry[] {
  return data.sectionLibrary.filter((e) => e.status === "CANDIDATE" || e.status === "APPROVED");
}

/** Add an entry to the section library; returns updated data. */
export function addSectionLibraryEntry(
  data: OSData,
  entry: Omit<SectionLibraryEntry, "approvedBy" | "approvedAt"> & { status?: SectionLibraryStatus },
): { data: OSData; entry: SectionLibraryEntry } {
  const newEntry: SectionLibraryEntry = { approvedBy: null, approvedAt: null, ...entry, status: entry.status ?? "CANDIDATE" };
  if (newEntry.buildStrategy === "NATIVE_NOVEL_BUILD") validateNoveltyJustification(newEntry);
  return { data: { ...data, sectionLibrary: [...data.sectionLibrary, newEntry] }, entry: newEntry };
}

/** Approve a section library entry (human only). Returns updated data. */
export function approveSectionEntry(
  data: OSData,
  entryId: string,
  approvedBy: string,
  approvedAt: ISODate,
): { data: OSData; entry: SectionLibraryEntry } {
  const existing = data.sectionLibrary.find((e) => e.id === entryId);
  if (!existing) throw new Error(`Section library entry ${entryId} not found`);
  const updated: SectionLibraryEntry = { ...existing, status: "APPROVED", approvedBy, approvedAt };
  return { data: { ...data, sectionLibrary: data.sectionLibrary.map((e) => (e.id === entryId ? updated : e)) }, entry: updated };
}
