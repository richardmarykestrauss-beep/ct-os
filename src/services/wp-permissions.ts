/**
 * WordPress Write Permission Service (CTOS-006 Part 5).
 *
 * Classifies write actions into GREEN / AMBER / RED tiers and enforces the ceiling.
 * Enforcement lives HERE in domain code — not only in dashboard UI.
 *
 * GREEN  — draft-safe: can execute automatically with existing AMBER job approval.
 * AMBER  — production content mutation: requires explicit human approval before execution.
 * RED    — destructive / infrastructure: never executed by A05 without named human authorisation.
 */
import type { PermissionLevel, WpEnvironment, WpWriteActionType } from "@/data/types";

// ---------------------------------------------------------------------------
// Action permission classification
// ---------------------------------------------------------------------------

const GREEN_ACTIONS = new Set<WpWriteActionType>([
  "CREATE_DRAFT_PAGE",
  "UPDATE_HEADING",      // on draft/preview only — enforced at execution time
  "UPDATE_TEXT",
  "UPDATE_BUTTON_LABEL",
  "UPDATE_BUTTON_URL",
  "REPLACE_IMAGE",       // draft/preview target only
  "UPDATE_WIDGET_CONTENT",
  "UPDATE_WIDGET_STYLE_SAFE",
  "UPDATE_CONTAINER_SETTINGS_SAFE",
  "ADD_APPROVED_SECTION",
  "REMOVE_DRAFT_SECTION",
  "REORDER_DRAFT_SECTIONS",
  "UPDATE_PAGE_TITLE",
  "UPDATE_PAGE_SLUG_DRAFT",
  "UPDATE_META_DESCRIPTION",
]);

const AMBER_ACTIONS = new Set<WpWriteActionType>([
  // (Reserved for production content mutation in future tickets)
  // Currently all actions are GREEN — production writes require AMBER upgrade at execution time
]);

/** Return the minimum permission tier for a write action type. */
export function actionPermissionTier(type: WpWriteActionType): PermissionLevel {
  if (AMBER_ACTIONS.has(type)) return "AMBER";
  if (GREEN_ACTIONS.has(type)) return "GREEN";
  // Unknown actions default to RED (fail-closed)
  return "RED";
}

/** Return the highest tier across a set of actions. */
export function planPermissionTier(types: WpWriteActionType[]): PermissionLevel {
  let tier: PermissionLevel = "GREEN";
  for (const t of types) {
    const at = actionPermissionTier(t);
    if (at === "RED") return "RED";
    if (at === "AMBER") tier = "AMBER";
  }
  return tier;
}

// ---------------------------------------------------------------------------
// Environment upgrade: production site + GREEN action = still requires AMBER
// ---------------------------------------------------------------------------

/**
 * Effective permission level when targeting a specific environment.
 * A GREEN draft action against a PRODUCTION site is automatically AMBER —
 * "production WordPress instance" ≠ "approved live mutation".
 */
export function effectiveWpPermissionLevel(
  actionTier: PermissionLevel,
  environment: WpEnvironment,
): PermissionLevel {
  if (actionTier === "RED") return "RED";
  if (environment === "PRODUCTION" && actionTier === "GREEN") return "AMBER";
  return actionTier;
}

// ---------------------------------------------------------------------------
// Safe style setting whitelist (Part 16)
// ---------------------------------------------------------------------------

const SAFE_STYLE_KEYS = new Set<string>([
  "text_align",
  "color",
  "background_color",
  "margin",
  "padding",
  "border_radius",
  "typography_font_size",
  "typography_font_weight",
  "width",
  "height",
  "responsive_visibility",
  "flex_justify_content",
  "flex_align_items",
]);

/** True when a style setting key is permitted under GREEN actions. */
export function isSafeStyleKey(key: string): boolean {
  return SAFE_STYLE_KEYS.has(key);
}

// ---------------------------------------------------------------------------
// Security validation (Part 32)
// ---------------------------------------------------------------------------

const UNSAFE_PATTERNS = [
  /javascript:/i,
  /<script/i,
  /on\w+\s*=/i,            // inline event handlers
  /eval\s*\(/i,
  /document\.cookie/i,
  /window\.location/i,
  /\bphp\b.*\bexec\b/i,
  /\bsystem\s*\(/i,
  /SELECT.*FROM/i,          // SQL injection attempt
  /DROP\s+TABLE/i,
  /INSERT\s+INTO/i,
];

/** Returns null if value is safe; otherwise returns the matched unsafe pattern description. */
export function detectUnsafeContent(value: string): string | null {
  for (const pattern of UNSAFE_PATTERNS) {
    if (pattern.test(value)) {
      return `Blocked pattern: ${pattern.source}`;
    }
  }
  return null;
}

/** Validate a URL is http/https and not javascript: or data: URI. */
export function validateSafeUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return `URL protocol "${parsed.protocol}" is not permitted. Only http: and https: are allowed.`;
    }
    return null;
  } catch {
    return `Invalid URL: "${url}"`;
  }
}

// ---------------------------------------------------------------------------
// Forbidden action guard (Part 35)
// ---------------------------------------------------------------------------

/** Actions that must never be executed — not included in WpWriteActionType, but guard against caller errors. */
const FORBIDDEN_ACTION_LABELS = [
  "DELETE_PRODUCTION_PAGE",
  "INSTALL_PLUGIN",
  "CHANGE_THEME",
  "CHANGE_DNS",
  "MODIFY_PAYMENT_GATEWAY",
  "MODIFY_GLOBAL_WOOCOMMERCE_SETTINGS",
  "DELETE_DATABASE",
  "MODIFY_USERS",
  "CHANGE_NAMESERVERS",
] as const;

export type ForbiddenActionLabel = typeof FORBIDDEN_ACTION_LABELS[number];

export function isForbiddenAction(label: string): label is ForbiddenActionLabel {
  return (FORBIDDEN_ACTION_LABELS as readonly string[]).includes(label);
}
