/**
 * Context budget mechanism (CTOS-005A Part 8).
 *
 * Replaces magic truncation constants with a documented, auditable budget plan.
 * No artifact content is silently truncated — every reduction is recorded.
 */
import type { ContextBudgetPlan, ContextReductionRecord } from "@/data/types";

// Approximate characters-to-tokens ratio (conservative; real ratio varies by model/content).
const CHARS_PER_TOKEN = 3.5;

/** Known context limits by provider (tokens). Conservative — models' actual limits are often higher. */
export const PROVIDER_CONTEXT_LIMITS: Record<string, number> = {
  claude: 190_000,
  openai: 128_000,
  gemini: 1_000_000,
  stub: 8_000,
};

/** Default output reservation per provider (tokens). */
export const PROVIDER_OUTPUT_RESERVES: Record<string, number> = {
  claude: 16_000,
  openai: 8_000,
  gemini: 8_000,
  stub: 2_000,
};

export interface BudgetAllocation {
  systemTokens: number;
  skillTokens: number;
  projectBriefTokens: number;
  inputArtifactTokens: number;
  evidenceTokens: number;
}

const DEFAULT_ALLOCATION: BudgetAllocation = {
  systemTokens: 2_000,
  skillTokens: 1_500,
  projectBriefTokens: 500,
  inputArtifactTokens: 0, // computed from remainder
  evidenceTokens: 500,
};

/**
 * Compute a context budget plan for a job.
 * Input artifact tokens get whatever is left after system, skills, brief, and evidence.
 */
export function planContextBudget(
  providerId: string,
  allocation: Partial<BudgetAllocation> = {},
): ContextBudgetPlan {
  const limit = PROVIDER_CONTEXT_LIMITS[providerId] ?? PROVIDER_CONTEXT_LIMITS.stub;
  const outputReserve = PROVIDER_OUTPUT_RESERVES[providerId] ?? PROVIDER_OUTPUT_RESERVES.stub;
  const a = { ...DEFAULT_ALLOCATION, ...allocation };

  const fixed = a.systemTokens + a.skillTokens + a.projectBriefTokens + a.evidenceTokens;
  const available = limit - outputReserve - fixed;
  const inputArtifactTokens = Math.max(0, allocation.inputArtifactTokens ?? available);
  const totalAllocated = fixed + inputArtifactTokens + outputReserve;

  return {
    providerLimitTokens: limit,
    reservedOutputTokens: outputReserve,
    systemBudgetTokens: a.systemTokens,
    skillBudgetTokens: a.skillTokens,
    projectBriefBudgetTokens: a.projectBriefTokens,
    inputArtifactBudgetTokens: inputArtifactTokens,
    evidenceBudgetTokens: a.evidenceTokens,
    totalAllocatedTokens: totalAllocated,
    remainingTokens: limit - totalAllocated,
  };
}

/** Estimate token count from a string (conservative heuristic, not billed). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Estimate token count from any JSON-serialisable value. */
export function estimateJsonTokens(value: unknown): number {
  return estimateTokens(JSON.stringify(value) ?? "");
}

/**
 * Reduce artifact content to fit within the budget.
 * NEVER cuts raw JSON mid-structure. Prefers structured field selection, then task excerpts.
 * Records the reduction so provenance is never lost (Part 8).
 */
export function reduceArtifactContent(
  artifactId: string,
  content: unknown,
  maxChars: number,
): { content: unknown; reduction: ContextReductionRecord | null } {
  const json = JSON.stringify(content);
  if (json.length <= maxChars) {
    return { content, reduction: null };
  }

  // Prefer structured field selection: include only string/array fields up to the limit.
  // For deeply nested content we fall back to a safe preview object.
  if (content !== null && typeof content === "object" && !Array.isArray(content)) {
    const reduced: Record<string, unknown> = {};
    let chars = 2; // for '{}'
    for (const [k, v] of Object.entries(content as Record<string, unknown>)) {
      const fieldJson = JSON.stringify({ [k]: v });
      if (chars + fieldJson.length - 2 <= maxChars) {
        reduced[k] = v;
        chars += fieldJson.length - 2;
      }
    }
    if (Object.keys(reduced).length > 0) {
      return {
        content: { ...reduced, _contextReduced: true, _originalChars: json.length },
        reduction: {
          artifactId,
          originalChars: json.length,
          reducedChars: JSON.stringify(reduced).length,
          method: "field_selection",
          summarized: false,
          sourceArtifactIdPreserved: true,
        },
      };
    }
  }

  // Fallback: safe truncation to nearest valid JSON boundary is not possible without a parser,
  // so we produce a safe wrapper that preserves the artifact ID and signals summarization needed.
  return {
    content: {
      _contextReduced: true,
      _originalChars: json.length,
      _maxChars: maxChars,
      _artifactId: artifactId,
      _note: "Content exceeds context budget. Request a summarization artifact or use Mode B.",
    },
    reduction: {
      artifactId,
      originalChars: json.length,
      reducedChars: maxChars,
      method: "truncated",
      summarized: false,
      sourceArtifactIdPreserved: true,
    },
  };
}

/** Chars budget from a token budget (inverse of estimateTokens). */
export function tokenBudgetToChars(tokens: number): number {
  return Math.floor(tokens * CHARS_PER_TOKEN);
}
