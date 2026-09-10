/**
 * RealWordPressRestAdapter — CTOS-006R1
 *
 * Production-quality WordPress REST API adapter implementing WordPressAdapter.
 *
 * Security constraints (Part 32):
 * - Credentials injected at construction time via opaque config; NEVER logged or returned.
 * - Strict endpoint allowlist — no arbitrary REST passthrough.
 * - Every write is followed by a fresh GET read-back before reporting success.
 * - Draft-only guarantee: createDraftPage always sends status=draft.
 * - Sanitized error messages never include Authorization header, password, or token.
 * - Timeout on every request — no hanging connections.
 */
import type {
  ElementorDocument,
  ElementorNode,
  ElementorNodeType,
  ElementorBridgePatch,
  ElementorBridgeRollback,
} from "@/data/types";
import type {
  WordPressAdapter,
  WpTransport,
  WpSiteInfo,
  WpPageMeta,
  WpMediaItem,
  WpConnectionCheck,
  WpWritePrimitive,
} from "./wp-adapter";

// ---------------------------------------------------------------------------
// Configuration — credentials never touch OSData or logs
// ---------------------------------------------------------------------------

export interface WpRestConfig {
  /** Full base URL, e.g. https://staging.example.com  (no trailing slash). */
  siteUrl: string;
  /** WordPress username. */
  username: string;
  /** WordPress Application Password (opaque — never logged). */
  appPassword: string;
  /** Request timeout in ms (default 15 000). */
  timeoutMs?: number;
}

/** Load config from environment variables. Throws if required vars are missing. */
export function wpRestConfigFromEnv(): WpRestConfig {
  const siteUrl = process.env["WP_TEST_SITE_URL"];
  const username = process.env["WP_TEST_USERNAME"];
  const appPassword = process.env["WP_TEST_APP_PASSWORD"];
  if (!siteUrl || !username || !appPassword) {
    throw new Error(
      "WordPress REST config incomplete. Required: WP_TEST_SITE_URL, WP_TEST_USERNAME, WP_TEST_APP_PASSWORD",
    );
  }
  return { siteUrl: siteUrl.replace(/\/$/, ""), username, appPassword };
}

// ---------------------------------------------------------------------------
// Allowed REST endpoint families (strict allowlist)
// ---------------------------------------------------------------------------

function assertAllowedUrl(url: string, siteUrl: string): void {
  const relative = url.startsWith(siteUrl) ? url.slice(siteUrl.length) : url;
  const allowed =
    relative === "/wp-json" ||
    relative === "/wp-json/" ||
    /^\/wp-json\/wp\/v2\/users\/me/.test(relative) ||
    /^\/wp-json\/wp\/v2\/pages(\/\d+)?(\/revisions(\/\d+)?)?(\?.*)?$/.test(relative) ||
    /^\/wp-json\/wp\/v2\/media\/\d+(\?.*)?$/.test(relative) ||
    /^\/wp-json\/wp\/v2\/settings(\?.*)?$/.test(relative) ||
    /^\/wp-json\/ctos\/v1\/elementor\/\d+$/.test(relative) ||           // CT Bridge: targeted patch + GET
    /^\/wp-json\/ctos\/v1\/elementor\/\d+\/rollback$/.test(relative); // CT Bridge: controlled rollback
  if (!allowed) {
    throw new Error(`WP REST: request to disallowed endpoint: ${relative}`);
  }
}

// ---------------------------------------------------------------------------
// Sanitised error — never exposes credentials
// ---------------------------------------------------------------------------

function sanitizeError(err: unknown, context: string): string {
  if (err instanceof Error) {
    // Strip anything that looks like an auth header or password
    const msg = err.message
      .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "[REDACTED]")
      .replace(/Authorization:[^\n]*/gi, "[REDACTED]")
      .replace(/password[^\s,;"]*/gi, "[REDACTED]");
    return `${context}: ${msg}`;
  }
  return `${context}: unknown error`;
}

// ---------------------------------------------------------------------------
// Stable content hash — deterministic, no crypto dependency needed at runtime
// ---------------------------------------------------------------------------

function stableHash(value: string): string {
  let h = 5381;
  for (let i = 0; i < value.length; i++) {
    h = ((h << 5) + h + value.charCodeAt(i)) >>> 0;
  }
  return `h${h.toString(16).padStart(8, "0")}`;
}

function pageHash(page: WpRestPage): string {
  // Excludes `modified` deliberately: the timestamp changes on every PATCH (including revision
  // restores), which would make snapshot-vs-restored comparisons always fail. Content and title
  // are the semantically meaningful fields for write verification and rollback checks.
  return stableHash(`${page.id}:${page.content.rendered}:${page.title.rendered}`);
}

// ---------------------------------------------------------------------------
// Raw REST page shape (subset we care about)
// ---------------------------------------------------------------------------

interface WpRestPage {
  id: number;
  slug: string;
  status: "publish" | "draft" | "private" | "pending" | "trash" | "auto-draft" | "inherit";
  title: { rendered: string; raw?: string };
  content: { rendered: string; raw?: string };
  excerpt: { rendered: string };
  modified: string;       // ISO date
  modified_gmt: string;
  meta?: Record<string, unknown>;
  yoast_head_json?: { description?: string };
}

interface WpRestRevision {
  id: number;
  parent: number;
  modified: string;
  title: { rendered: string };
}

interface WpRestUser {
  id: number;
  name: string;
  capabilities?: Record<string, boolean>;
}

interface WpRestRoot {
  name?: string;
  description?: string;
  url?: string;
  gmt_offset?: number;
  namespaces?: string[];
  authentication?: Record<string, unknown>;
  routes?: Record<string, unknown>;
  generator?: string;   // "WordPress X.Y.Z"
}

// ---------------------------------------------------------------------------
// CT Bridge response shapes (ctos/v1 namespace)
// ---------------------------------------------------------------------------

interface CtBridgeDocumentResponse {
  page_id: number;
  elementor_managed: boolean;
  elementor_edit_mode: string | null;
  document_hash: string;
  elementor_data: unknown[];
}

interface CtBridgePatchResponse {
  page_id: number;
  previous_hash: string;
  document_hash: string;
}

interface CtBridgeRollbackResponse {
  page_id: number;
  previous_hash: string;
  document_hash: string;
  snapshot_hash: string;
}

// Raw Elementor node as stored in _elementor_data
interface RawElementorNode {
  id: string;
  elType: string;
  widgetType?: string;
  settings: Record<string, unknown>;
  elements?: RawElementorNode[];
  [key: string]: unknown;  // all other Elementor fields preserved
}

// Safe Elementor style setting keys (must match wp-permissions.ts SAFE_STYLE_KEYS)
const BRIDGE_SAFE_STYLE_KEYS = new Set([
  "text_align", "color", "background_color", "margin", "padding",
  "border_radius", "typography_font_size", "typography_font_weight",
  "width", "height", "responsive_visibility", "flex_justify_content", "flex_align_items",
]);

// ---------------------------------------------------------------------------
// Elementor node type inference — Raw ↔ Typed conversion
// ---------------------------------------------------------------------------

function inferNodeType(elType: string, widgetType?: string): ElementorNodeType {
  if (elType === "widget") {
    switch (widgetType) {
      case "heading":     return "heading";
      case "text-editor": return "text";
      case "button":      return "button";
      case "image":       return "image";
      default:            return "unknown";
    }
  }
  if (elType === "container" || elType === "section" || elType === "column" || elType === "inner-section") {
    return "container";
  }
  return "unknown";
}

/** Extract only the typed settings we manage — everything else lives in _preserved.settings */
function extractTypedSettings(type: ElementorNodeType, raw: Record<string, unknown>): Record<string, unknown> {
  switch (type) {
    case "heading":
      return { title: raw["title"] ?? "" };
    case "text":
      return { editor: raw["editor"] ?? "" };
    case "button":
      return { button_text: raw["button_text"] ?? "", button_url: raw["button_url"] ?? {} };
    case "image":
      return { image: raw["image"] ?? {} };
    case "container": {
      const safe: Record<string, unknown> = {};
      for (const key of BRIDGE_SAFE_STYLE_KEYS) {
        if (key in raw) safe[key] = raw[key];
      }
      return safe;
    }
    default:
      return {};
  }
}

/** Convert one raw Elementor node to a typed ElementorNode, preserving all unknown fields. */
function rawToElementorNode(raw: RawElementorNode): ElementorNode {
  const type   = inferNodeType(raw.elType, raw.widgetType);
  const typed  = extractTypedSettings(type, raw.settings ?? {});
  const kids   = (raw.elements ?? []).map((c) => rawToElementorNode(c as RawElementorNode));

  // _preserved holds the full raw node (minus elements which become children) for round-trip safety.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { elements: _el, ...restRaw } = raw as Record<string, unknown>;
  const preserved: Record<string, unknown> = { ...restRaw };

  return { id: raw.id, type, settings: typed, children: kids, _preserved: preserved };
}

// ---------------------------------------------------------------------------
// HTTP transport (injectable for tests)
// ---------------------------------------------------------------------------

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------
// RealWordPressRestAdapter
// ---------------------------------------------------------------------------

export class RealWordPressRestAdapter implements WordPressAdapter {
  readonly transport: WpTransport = "REST_API";

  private readonly base: string;
  private readonly authHeader: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchFn;

  constructor(config: WpRestConfig, fetchFn?: FetchFn) {
    this.base = config.siteUrl.replace(/\/$/, "");
    // Basic auth — credentials held in memory only, never logged
    this.authHeader = "Basic " + Buffer.from(`${config.username}:${config.appPassword}`).toString("base64");
    this.timeoutMs = config.timeoutMs ?? 15_000;
    this.fetchFn = fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  // -------------------------------------------------------------------------
  // Internal HTTP helpers
  // -------------------------------------------------------------------------

  private url(path: string): string {
    return `${this.base}${path}`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const fullUrl = this.url(path);
    assertAllowedUrl(fullUrl, this.base);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const init: RequestInit = {
      method,
      signal: controller.signal,
      headers: {
        "Authorization": this.authHeader,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };

    let res: Response;
    try {
      res = await this.fetchFn(fullUrl, init);
    } catch (err) {
      throw new Error(sanitizeError(err, `${method} ${path} network error`));
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const safe = text.replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "[REDACTED]").slice(0, 200);
      throw new Error(`${method} ${path} → HTTP ${res.status}: ${safe}`);
    }

    return res.json() as Promise<T>;
  }

  private get<T>(path: string): Promise<T> { return this.request<T>("GET", path); }
  private post<T>(path: string, body: unknown): Promise<T> { return this.request<T>("POST", path, body); }
  private patch<T>(path: string, body: unknown): Promise<T> { return this.request<T>("PATCH", path, body); }

  // -------------------------------------------------------------------------
  // READ — verifyConnection
  // -------------------------------------------------------------------------

  async verifyConnection(): Promise<WpConnectionCheck> {
    // Step 1: check WP REST root (unauthenticated)
    let restApiReachable = false;
    try {
      await this.get<WpRestRoot>("/wp-json/");
      restApiReachable = true;
    } catch {
      return { online: false, authOk: false, restApiReachable: false, elementorAccessible: false, error: "REST API not reachable" };
    }

    // Step 2: authenticated users/me
    let authOk = false;
    try {
      await this.get<WpRestUser>("/wp-json/wp/v2/users/me");
      authOk = true;
    } catch (err) {
      return { online: true, authOk: false, restApiReachable, elementorAccessible: false, error: sanitizeError(err, "auth check") };
    }

    // Step 3: Elementor — best-effort detection via plugin namespaces
    let elementorAccessible = false;
    try {
      const root = await this.get<WpRestRoot>("/wp-json/");
      const namespaces = root.namespaces ?? [];
      elementorAccessible = namespaces.some((ns) => ns.startsWith("elementor"));
    } catch {
      // non-fatal — just report false
    }

    return { online: true, authOk, restApiReachable, elementorAccessible, error: null };
  }

  // -------------------------------------------------------------------------
  // READ — getSiteInfo
  // -------------------------------------------------------------------------

  async getSiteInfo(): Promise<WpSiteInfo> {
    const [root, settings] = await Promise.all([
      this.get<WpRestRoot>("/wp-json/").catch(() => ({} as WpRestRoot)),
      this.get<Record<string, unknown>>("/wp-json/wp/v2/settings").catch(() => ({} as Record<string, unknown>)),
    ]);

    // WordPress version extracted from generator string "WordPress X.Y.Z"
    const generator = (root.generator ?? "") as string;
    const wpMatch = generator.match(/WordPress[\s/]+([\d.]+)/i);
    const wpVersion = wpMatch?.[1] ?? "unknown";

    // Elementor version: standard REST doesn't expose it; check namespaces for presence
    const namespaces = root.namespaces ?? [];
    const hasElementor = namespaces.some((ns) => ns.startsWith("elementor"));
    const elementorVersion = hasElementor ? "detected" : null;

    const siteName = (typeof settings["title"] === "string" ? settings["title"] : undefined) ?? root.name ?? "";

    return {
      url: this.base,
      name: siteName,
      wpVersion,
      elementorVersion,
      restApiEnabled: true,
    };
  }

  // -------------------------------------------------------------------------
  // READ — getPage
  // -------------------------------------------------------------------------

  async getPage(pageId: string): Promise<WpPageMeta | null> {
    try {
      const page = await this.get<WpRestPage>(`/wp-json/wp/v2/pages/${pageId}?context=edit`);
      return this.toPageMeta(page);
    } catch (err) {
      if (err instanceof Error && err.message.includes("HTTP 404")) return null;
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // READ — getPageMeta
  // -------------------------------------------------------------------------

  async getPageMeta(pageId: string): Promise<Record<string, string>> {
    try {
      const page = await this.get<WpRestPage>(`/wp-json/wp/v2/pages/${pageId}?context=edit`);
      const result: Record<string, string> = {};
      if (page.meta) {
        for (const [k, v] of Object.entries(page.meta)) {
          if (typeof v === "string") result[k] = v;
        }
      }
      // Include Yoast meta description if present
      if (page.yoast_head_json?.description) {
        result["_yoast_wpseo_metadesc"] = page.yoast_head_json.description;
      }
      return result;
    } catch (err) {
      if (err instanceof Error && err.message.includes("HTTP 404")) return {};
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // READ — getElementorDocument via CT Bridge
  // -------------------------------------------------------------------------

  async getElementorDocument(pageId: string): Promise<ElementorDocument | null> {
    // Requires the CT Bridge plugin to be installed and active on the WordPress site.
    // Bridge endpoint: GET /wp-json/ctos/v1/elementor/{pageId}
    // Returns null when: page not found (404), page not Elementor-managed (422).
    try {
      const res = await this.get<CtBridgeDocumentResponse>(`/wp-json/ctos/v1/elementor/${pageId}`);
      if (!res.elementor_managed || !Array.isArray(res.elementor_data)) return null;
      return {
        pageId,
        version: "bridge",
        documentHash: res.document_hash,
        nodes: res.elementor_data.map((n) => rawToElementorNode(n as RawElementorNode)),
      };
    } catch (err) {
      // Page not found or not Elementor-managed — both signal "not available"
      if (err instanceof Error && (err.message.includes("HTTP 404") || err.message.includes("HTTP 422"))) {
        return null;
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // READ — getMediaItem
  // -------------------------------------------------------------------------

  async getMediaItem(mediaId: string): Promise<WpMediaItem | null> {
    try {
      const item = await this.get<{ id: number; source_url: string; alt_text: string; mime_type: string }>(
        `/wp-json/wp/v2/media/${mediaId}`,
      );
      return {
        id: String(item.id),
        url: item.source_url,
        altText: item.alt_text,
        mimeType: item.mime_type,
      };
    } catch (err) {
      if (err instanceof Error && err.message.includes("HTTP 404")) return null;
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // READ — getSiteSettings
  // -------------------------------------------------------------------------

  async getSiteSettings(keys: string[]): Promise<Record<string, string>> {
    const settings = await this.get<Record<string, unknown>>("/wp-json/wp/v2/settings");
    const result: Record<string, string> = {};
    for (const k of keys) {
      const v = settings[k];
      if (typeof v === "string") result[k] = v;
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // WRITE — createDraftPage (always draft — no publish path)
  // -------------------------------------------------------------------------

  async createDraftPage(params: { title: string; slug: string; metaDescription?: string }): Promise<WpWritePrimitive & { pageId: string }> {
    const body: Record<string, unknown> = {
      title: params.title,
      slug: params.slug,
      status: "draft",    // IMMUTABLE — never overrideable
      content: "",
    };
    if (params.metaDescription) {
      body["meta"] = { _yoast_wpseo_metadesc: params.metaDescription };
    }

    const created = await this.post<WpRestPage>("/wp-json/wp/v2/pages", body);

    // Safety: if WordPress somehow responded with a non-draft status, abort
    if (created.status !== "draft" && created.status !== "auto-draft") {
      throw new Error(`createDraftPage: WordPress returned status "${created.status}" — expected draft. Aborting.`);
    }

    // Read-back immediately to get stable hash
    const readBack = await this.get<WpRestPage>(`/wp-json/wp/v2/pages/${created.id}?context=edit`);
    const hash = pageHash(readBack);

    return {
      pageId: String(created.id),
      resultToken: `rest_create_${created.id}`,
      afterStateHash: hash,
    };
  }

  // -------------------------------------------------------------------------
  // WRITE — updatePageContent
  // -------------------------------------------------------------------------

  async updatePageContent(pageId: string, params: { field: string; value: string }): Promise<WpWritePrimitive> {
    // Map our field names to WordPress REST fields
    const fieldMap: Record<string, string> = {
      title:            "title",
      content:          "content",
      excerpt:          "excerpt",
      slug:             "slug",
      meta_description: "meta._yoast_wpseo_metadesc",
    };

    const wpField = fieldMap[params.field] ?? params.field;

    // Build patch body, handling nested meta paths
    let patchBody: Record<string, unknown>;
    if (wpField.startsWith("meta.")) {
      const metaKey = wpField.slice(5);
      patchBody = { meta: { [metaKey]: params.value } };
    } else {
      patchBody = { [wpField]: params.value };
    }

    await this.patch<WpRestPage>(`/wp-json/wp/v2/pages/${pageId}`, patchBody);

    // Read-back — do not trust PATCH response
    const readBack = await this.get<WpRestPage>(`/wp-json/wp/v2/pages/${pageId}?context=edit`);
    const hash = pageHash(readBack);

    return {
      resultToken: `rest_update_${pageId}_${params.field}`,
      afterStateHash: hash,
    };
  }

  // -------------------------------------------------------------------------
  // WRITE — updatePageMeta
  // -------------------------------------------------------------------------

  async updatePageMeta(pageId: string, meta: Record<string, string>): Promise<WpWritePrimitive> {
    await this.patch<WpRestPage>(`/wp-json/wp/v2/pages/${pageId}`, { meta });

    const readBack = await this.get<WpRestPage>(`/wp-json/wp/v2/pages/${pageId}?context=edit`);
    const hash = pageHash(readBack);

    return {
      resultToken: `rest_meta_${pageId}`,
      afterStateHash: hash,
    };
  }

  // -------------------------------------------------------------------------
  // READ — getElementorSnapshot (raw nodes for pre-write archival)
  // -------------------------------------------------------------------------

  async getElementorSnapshot(pageId: string): Promise<{ documentHash: string; rawNodes: unknown[] } | null> {
    // Returns the raw bridge GET response without converting to typed nodes.
    // The raw nodes are stored in WebsiteRevisionSnapshot.elementorSnapshotRaw so that
    // rollback can send them back byte-for-byte, preserving the PHP-computed hash.
    try {
      const res = await this.get<CtBridgeDocumentResponse>(`/wp-json/ctos/v1/elementor/${pageId}`);
      if (!res.elementor_managed || !Array.isArray(res.elementor_data)) return null;
      return { documentHash: res.document_hash, rawNodes: res.elementor_data };
    } catch (err) {
      if (err instanceof Error && (err.message.includes("HTTP 404") || err.message.includes("HTTP 422"))) {
        return null;
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // WRITE — updateElementorDocument (structural ops — not via targeted patch)
  // -------------------------------------------------------------------------

  async updateElementorDocument(pageId: string, _doc: ElementorDocument): Promise<WpWritePrimitive> {
    // Structural Elementor writes (ADD_APPROVED_SECTION, REMOVE_DRAFT_SECTION,
    // REORDER_DRAFT_SECTIONS) are not supported via the CT Bridge targeted patch
    // endpoint. The bridge only accepts targeted single-element mutations.
    // These operations must be routed through the engine's fallback path or deferred.
    throw new Error(
      `updateElementorDocument: structural Elementor writes are not supported via the CT Bridge. ` +
      `Use applyElementorPatch for SET_WIDGET_TEXT, SET_WIDGET_LINK, SET_IMAGE, or SET_SETTING.` +
      ` Page: ${pageId}`,
    );
  }

  // -------------------------------------------------------------------------
  // WRITE — applyElementorPatch (targeted single-element mutation via CT Bridge)
  // -------------------------------------------------------------------------

  async applyElementorPatch(pageId: string, patch: ElementorBridgePatch): Promise<WpWritePrimitive> {
    // Bridge endpoint: PATCH /wp-json/ctos/v1/elementor/{pageId}
    // Sends a targeted patch descriptor — NOT the full document.
    // The PHP bridge locates the element, validates the operation and value,
    // mutates only that one setting, and returns the new document hash.
    const res = await this.patch<CtBridgePatchResponse>(
      `/wp-json/ctos/v1/elementor/${pageId}`,
      {
        expected_document_hash: patch.expectedDocumentHash,
        patch: {
          operation:              patch.operation,
          element_id:             patch.elementId,
          expected_element_type:  patch.expectedElementType,
          ...(patch.expectedCurrentValue !== undefined ? { expected_current_value: patch.expectedCurrentValue } : {}),
          ...(patch.key !== undefined ? { key: patch.key } : {}),
          value:                  patch.value,
        },
      },
    );

    // Read-back verification: re-fetch and confirm the new hash.
    const readBack = await this.getElementorDocument(pageId);
    if (readBack === null || readBack.documentHash !== res.document_hash) {
      throw new Error(
        `applyElementorPatch: read-back hash mismatch after write to page ${pageId}. ` +
        `Expected ${res.document_hash}, got ${readBack?.documentHash ?? "null"}.`,
      );
    }

    return {
      resultToken: `bridge_patch_${pageId}_${res.document_hash.slice(0, 8)}`,
      afterStateHash: res.document_hash,
    };
  }

  // -------------------------------------------------------------------------
  // WRITE — rollbackElementorDocument via CT Bridge rollback endpoint
  // -------------------------------------------------------------------------

  async rollbackElementorDocument(pageId: string, params: ElementorBridgeRollback): Promise<WpWritePrimitive> {
    // Bridge endpoint: POST /wp-json/ctos/v1/elementor/{pageId}/rollback
    // The bridge verifies:
    //   1. expected_document_hash matches current live document (conflict protection)
    //   2. hash(elementor_data) === snapshot_hash (snapshot integrity)
    // Only if both pass does it restore the snapshot.
    const res = await this.post<CtBridgeRollbackResponse>(
      `/wp-json/ctos/v1/elementor/${pageId}/rollback`,
      {
        snapshot_hash:           params.snapshotHash,
        expected_document_hash:  params.expectedCurrentHash,
        elementor_data:          params.elementorData,
      },
    );

    // Read-back verification: confirm restored hash matches rollback response.
    const readBack = await this.getElementorDocument(pageId);
    if (readBack === null || readBack.documentHash !== res.document_hash) {
      throw new Error(
        `rollbackElementorDocument: read-back hash mismatch after rollback of page ${pageId}. ` +
        `Expected ${res.document_hash}, got ${readBack?.documentHash ?? "null"}.`,
      );
    }

    return {
      resultToken: `bridge_rollback_${pageId}_${res.document_hash.slice(0, 8)}`,
      afterStateHash: res.document_hash,
    };
  }

  // -------------------------------------------------------------------------
  // WRITE — createRevisionSnapshot
  // -------------------------------------------------------------------------

  async createRevisionSnapshot(pageId: string): Promise<{ snapshotToken: string; revisionId: string; contentHash: string }> {
    // WordPress creates a revision automatically on every PATCH.
    // We trigger a no-op content patch to force a revision, then read back the latest.
    const current = await this.get<WpRestPage>(`/wp-json/wp/v2/pages/${pageId}?context=edit`);
    const currentHash = pageHash(current);

    // Force a revision via a sentinel content append/revert cycle — or just list existing revisions
    const revisions = await this.get<WpRestRevision[]>(`/wp-json/wp/v2/pages/${pageId}/revisions`);
    const latest = revisions[0];

    if (!latest) {
      // No revisions yet — create one by a no-op patch
      await this.patch<WpRestPage>(`/wp-json/wp/v2/pages/${pageId}`, { content: current.content.raw ?? current.content.rendered });
      const revisions2 = await this.get<WpRestRevision[]>(`/wp-json/wp/v2/pages/${pageId}/revisions`);
      const rev = revisions2[0];
      if (!rev) throw new Error(`createRevisionSnapshot: could not obtain revision for page ${pageId}`);
      return {
        snapshotToken: `rest_snap_${pageId}_${rev.id}`,
        revisionId: String(rev.id),
        contentHash: currentHash,
      };
    }

    return {
      snapshotToken: `rest_snap_${pageId}_${latest.id}`,
      revisionId: String(latest.id),
      contentHash: currentHash,
    };
  }

  // -------------------------------------------------------------------------
  // WRITE — restoreRevisionSnapshot
  // -------------------------------------------------------------------------

  async restoreRevisionSnapshot(pageId: string, revisionId: string): Promise<WpWritePrimitive> {
    // Fetch the revision content
    const revision = await this.get<WpRestPage>(`/wp-json/wp/v2/pages/${pageId}/revisions/${revisionId}`);

    // Restore by patching page with revision content/title
    const patchBody: Record<string, unknown> = {
      title: revision.title.raw ?? revision.title.rendered,
      content: revision.content.raw ?? revision.content.rendered,
    };
    await this.patch<WpRestPage>(`/wp-json/wp/v2/pages/${pageId}`, patchBody);

    // Read-back
    const readBack = await this.get<WpRestPage>(`/wp-json/wp/v2/pages/${pageId}?context=edit`);
    const hash = pageHash(readBack);

    return {
      resultToken: `rest_restore_${pageId}_${revisionId}`,
      afterStateHash: hash,
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private toPageMeta(page: WpRestPage): WpPageMeta {
    const status = (["publish", "draft", "private", "pending", "trash"].includes(page.status)
      ? page.status
      : "draft") as WpPageMeta["status"];

    const metaDesc =
      (page.meta?.["_yoast_wpseo_metadesc"] as string | undefined) ??
      page.yoast_head_json?.description ??
      null;

    return {
      id: String(page.id),
      title: page.title.rendered,
      slug: page.slug,
      status,
      modifiedAt: page.modified,
      contentHash: pageHash(page),
      metaDescription: metaDesc,
    };
  }
}
