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
    /^\/wp-json\/wp\/v2\/settings(\?.*)?$/.test(relative);
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
  // READ — getElementorDocument (not supported via core REST)
  // -------------------------------------------------------------------------

  async getElementorDocument(_pageId: string): Promise<ElementorDocument | null> {
    // Elementor stores its data in wp_postmeta (_elementor_data).
    // Standard WordPress REST does not expose arbitrary postmeta safely.
    // A CT Bridge endpoint is required for real Elementor document reads.
    // Returning null signals "not available" — caller must handle gracefully.
    return null;
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
  // WRITE — updateElementorDocument (not supported via core REST)
  // -------------------------------------------------------------------------

  async updateElementorDocument(_pageId: string, _doc: ElementorDocument): Promise<WpWritePrimitive> {
    throw new Error(
      "updateElementorDocument is not supported by the REST adapter. " +
      "Elementor document writes require a CT Bridge endpoint. " +
      "Use updatePageContent for standard WordPress content edits.",
    );
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
