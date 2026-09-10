/**
 * WordPress Adapter Interface + Fake Adapter (CTOS-006 Parts 2, 3, 29).
 *
 * WordPressAdapter: narrow, provider-neutral interface for read/write primitives.
 * FakeWordPressAdapter: in-memory implementation for tests and development.
 *
 * Security constraints (Part 32):
 * - Adapter NEVER receives raw auth headers, passwords, or tokens as function arguments.
 * - Transport credentials are injected at construction time via opaque config — never logged.
 * - No arbitrary SQL, no arbitrary PHP, no unrestricted REST endpoints.
 * - All write results must be read back and verified — HTTP 200 alone is not success.
 */
import type {
  ElementorDocument,
  ElementorNode,
  ElementorBridgePatch,
  ElementorBridgeRollback,
} from "@/data/types";

// ---------------------------------------------------------------------------
// Transport types
// ---------------------------------------------------------------------------

export type WpTransport = "REST_API" | "CT_BRIDGE" | "FAKE";

export interface WpSiteInfo {
  url: string;
  name: string;
  wpVersion: string;
  elementorVersion: string | null;
  restApiEnabled: boolean;
}

export interface WpPageMeta {
  id: string;
  title: string;
  slug: string;
  status: "publish" | "draft" | "private" | "pending" | "trash";
  modifiedAt: string;
  /** Opaque hash of page content for precondition checks. */
  contentHash: string;
  metaDescription: string | null;
}

export interface WpMediaItem {
  id: string;
  url: string;
  altText: string;
  mimeType: string;
}

export interface WpRevision {
  id: string;
  parentId: string;
  createdAt: string;
  modifiedAt: string;
}

export interface WpWritePrimitive {
  /** Opaque result token for read-back verification — NOT the response body. */
  resultToken: string;
  /** Hash of the state after write — compared against expected after-state. */
  afterStateHash: string;
}

export interface WpConnectionCheck {
  online: boolean;
  authOk: boolean;
  restApiReachable: boolean;
  elementorAccessible: boolean;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Adapter interface (Part 2)
// ---------------------------------------------------------------------------

/** Narrow, provider-neutral adapter for WordPress/Elementor read/write primitives. */
export interface WordPressAdapter {
  readonly transport: WpTransport;

  // READ
  verifyConnection(): Promise<WpConnectionCheck>;
  getSiteInfo(): Promise<WpSiteInfo>;
  getPage(pageId: string): Promise<WpPageMeta | null>;
  getPageMeta(pageId: string): Promise<Record<string, string>>;
  getElementorDocument(pageId: string): Promise<ElementorDocument | null>;
  getMediaItem(mediaId: string): Promise<WpMediaItem | null>;
  getSiteSettings(keys: string[]): Promise<Record<string, string>>;

  // WRITE / PREPARE (always produce a result token for read-back)
  createDraftPage(params: { title: string; slug: string; metaDescription?: string }): Promise<WpWritePrimitive & { pageId: string }>;
  updatePageContent(pageId: string, params: { field: string; value: string }): Promise<WpWritePrimitive>;
  updatePageMeta(pageId: string, meta: Record<string, string>): Promise<WpWritePrimitive>;
  updateElementorDocument(pageId: string, doc: ElementorDocument): Promise<WpWritePrimitive>;
  /**
   * Apply a TARGETED mutation to one Elementor element via the CT Bridge.
   * Only SET_WIDGET_TEXT | SET_WIDGET_LINK | SET_IMAGE | SET_SETTING are permitted.
   * Arbitrary full-document replacement is not accepted.
   */
  applyElementorPatch(pageId: string, patch: ElementorBridgePatch): Promise<WpWritePrimitive>;
  /**
   * Fetch raw Elementor snapshot data for pre-write archival.
   * Returns the bridge GET response (document_hash + raw elementor_data nodes)
   * without converting to typed nodes — preserving exact JSON for rollback hash fidelity.
   */
  getElementorSnapshot(pageId: string): Promise<{ documentHash: string; rawNodes: unknown[] } | null>;
  /**
   * Restore a prior Elementor document from a CT-OS snapshot via the bridge rollback endpoint.
   * Gated by snapshot hash integrity and current-document conflict protection.
   */
  rollbackElementorDocument(pageId: string, params: ElementorBridgeRollback): Promise<WpWritePrimitive>;
  createRevisionSnapshot(pageId: string): Promise<{ snapshotToken: string; revisionId: string; contentHash: string }>;
  restoreRevisionSnapshot(pageId: string, revisionId: string): Promise<WpWritePrimitive>;
}

// ---------------------------------------------------------------------------
// Fake adapter (Part 29) — in-memory, no network calls
// ---------------------------------------------------------------------------

export interface FakePageRecord {
  id: string;
  title: string;
  slug: string;
  status: WpPageMeta["status"];
  modifiedAt: string;
  contentHash: string;
  metaDescription: string | null;
  meta: Record<string, string>;
  elementorDoc: ElementorDocument | null;
}

export interface FakeAdapterConfig {
  /** Simulate connection failure. */
  offline?: boolean;
  /** Simulate auth failure. */
  authFail?: boolean;
  /** Simulate write failure on this page id. */
  writeFailPageId?: string;
  /** Simulate read-back mismatch on this page id. */
  readBackMismatchPageId?: string;
  /** Existing pages to seed. */
  pages?: FakePageRecord[];
  /** Simulate conflict: pre-existing hash differs from expected. */
  conflictPageId?: string;
}

/** Deterministic hash for test purposes. */
function fakeHash(value: string): string {
  let h = 0;
  for (let i = 0; i < value.length; i++) {
    h = (h * 31 + value.charCodeAt(i)) >>> 0;
  }
  return `hash_${h.toString(16).padStart(8, "0")}`;
}

function makeNode(id: string, type: ElementorNode["type"]): ElementorNode {
  return { id, type, settings: {}, children: [], _preserved: {} };
}

export class FakeWordPressAdapter implements WordPressAdapter {
  readonly transport: WpTransport = "FAKE";

  private pages = new Map<string, FakePageRecord>();
  private revisions = new Map<string, { revisionId: string; contentHash: string; doc: ElementorDocument | null }>();
  private nextPageId = 1;
  readonly callLog: { method: string; args: unknown[] }[] = [];

  constructor(private config: FakeAdapterConfig = {}) {
    for (const p of config.pages ?? []) {
      this.pages.set(p.id, { ...p });
    }
  }

  async verifyConnection(): Promise<WpConnectionCheck> {
    this.log("verifyConnection", []);
    if (this.config.offline) {
      return { online: false, authOk: false, restApiReachable: false, elementorAccessible: false, error: "Connection refused" };
    }
    if (this.config.authFail) {
      return { online: true, authOk: false, restApiReachable: true, elementorAccessible: false, error: "Authentication failed" };
    }
    return { online: true, authOk: true, restApiReachable: true, elementorAccessible: true, error: null };
  }

  async getSiteInfo(): Promise<WpSiteInfo> {
    this.log("getSiteInfo", []);
    if (this.config.offline) throw new Error("Site offline");
    return {
      url: "https://fake-wp.test",
      name: "Fake WP Site",
      wpVersion: "6.5.0",
      elementorVersion: "3.20.0",
      restApiEnabled: true,
    };
  }

  async getPage(pageId: string): Promise<WpPageMeta | null> {
    this.log("getPage", [pageId]);
    return this.pages.get(pageId) ?? null;
  }

  async getPageMeta(pageId: string): Promise<Record<string, string>> {
    this.log("getPageMeta", [pageId]);
    return this.pages.get(pageId)?.meta ?? {};
  }

  async getElementorDocument(pageId: string): Promise<ElementorDocument | null> {
    this.log("getElementorDocument", [pageId]);
    const p = this.pages.get(pageId);
    if (!p) return null;
    return p.elementorDoc ?? {
      pageId,
      version: "3.20",
      documentHash: p.contentHash,
      nodes: [makeNode("root", "container")],
    };
  }

  async getMediaItem(mediaId: string): Promise<WpMediaItem | null> {
    this.log("getMediaItem", [mediaId]);
    if (!mediaId) return null;
    return { id: mediaId, url: `https://fake-wp.test/wp-content/uploads/${mediaId}.jpg`, altText: "Fake image", mimeType: "image/jpeg" };
  }

  async getSiteSettings(keys: string[]): Promise<Record<string, string>> {
    this.log("getSiteSettings", [keys]);
    return Object.fromEntries(keys.map((k) => [k, `fake_${k}`]));
  }

  async createDraftPage(params: { title: string; slug: string; metaDescription?: string }): Promise<WpWritePrimitive & { pageId: string }> {
    this.log("createDraftPage", [params]);
    if (this.config.offline) throw new Error("Site offline");
    const pageId = `page_${this.nextPageId++}`;
    const contentHash = fakeHash(`${params.title}:${params.slug}`);
    this.pages.set(pageId, {
      id: pageId,
      title: params.title,
      slug: params.slug,
      status: "draft",
      modifiedAt: new Date().toISOString(),
      contentHash,
      metaDescription: params.metaDescription ?? null,
      meta: {},
      elementorDoc: null,
    });
    return { pageId, resultToken: `tok_${pageId}`, afterStateHash: contentHash };
  }

  async updatePageContent(pageId: string, params: { field: string; value: string }): Promise<WpWritePrimitive> {
    this.log("updatePageContent", [pageId, params]);
    if (this.config.offline) throw new Error("Site offline");
    if (pageId === this.config.writeFailPageId) throw new Error("Simulated write failure");
    const p = this.pages.get(pageId);
    if (!p) throw new Error(`Page ${pageId} not found`);
    const updated = { ...p, [params.field]: params.value, modifiedAt: new Date().toISOString() };
    updated.contentHash = pageId === this.config.readBackMismatchPageId
      ? fakeHash("mismatch_intentional")
      : fakeHash(`${params.field}:${params.value}`);
    this.pages.set(pageId, updated);
    return { resultToken: `tok_${pageId}_${params.field}`, afterStateHash: updated.contentHash };
  }

  async updatePageMeta(pageId: string, meta: Record<string, string>): Promise<WpWritePrimitive> {
    this.log("updatePageMeta", [pageId, meta]);
    if (this.config.offline) throw new Error("Site offline");
    const p = this.pages.get(pageId);
    if (!p) throw new Error(`Page ${pageId} not found`);
    const updated = { ...p, meta: { ...p.meta, ...meta }, modifiedAt: new Date().toISOString() };
    this.pages.set(pageId, updated);
    return { resultToken: `tok_meta_${pageId}`, afterStateHash: fakeHash(JSON.stringify(updated.meta)) };
  }

  async updateElementorDocument(pageId: string, doc: ElementorDocument): Promise<WpWritePrimitive> {
    this.log("updateElementorDocument", [pageId, doc]);
    if (this.config.offline) throw new Error("Site offline");
    if (pageId === this.config.writeFailPageId) throw new Error("Simulated write failure");
    const p = this.pages.get(pageId);
    if (!p) throw new Error(`Page ${pageId} not found`);
    const updatedDoc = { ...doc, documentHash: fakeHash(JSON.stringify(doc.nodes)) };
    const updated = { ...p, elementorDoc: updatedDoc, modifiedAt: new Date().toISOString() };
    this.pages.set(pageId, updated);
    return { resultToken: `tok_elmt_${pageId}`, afterStateHash: updatedDoc.documentHash };
  }

  async applyElementorPatch(pageId: string, patch: ElementorBridgePatch): Promise<WpWritePrimitive> {
    this.log("applyElementorPatch", [pageId, patch]);
    if (this.config.offline) throw new Error("Site offline");
    if (pageId === this.config.writeFailPageId) throw new Error("Simulated write failure");
    const p = this.pages.get(pageId);
    if (!p) throw new Error(`Page ${pageId} not found`);
    // Conflict check
    const currentDoc = p.elementorDoc ?? { pageId, version: "fake", documentHash: p.contentHash, nodes: [] };
    if (currentDoc.documentHash !== patch.expectedDocumentHash) {
      throw new Error(`conflict_detected: document changed since read (expected ${patch.expectedDocumentHash})`);
    }
    // Apply patch to in-memory doc (simplified: just update the matching node's settings)
    function applyToNodes(nodes: ElementorNode[]): ElementorNode[] {
      return nodes.map((n) => {
        if (n.id === patch.elementId) {
          const settings = { ...n.settings };
          switch (patch.operation) {
            case "SET_WIDGET_TEXT":
              Object.assign(settings, { title: patch.value, editor: patch.value, button_text: patch.value });
              break;
            case "SET_WIDGET_LINK":
              settings["button_url"] = patch.value;
              break;
            case "SET_IMAGE":
              settings["image"] = patch.value;
              break;
            case "SET_SETTING":
              if (patch.key) settings[patch.key] = patch.value;
              break;
          }
          return { ...n, settings };
        }
        return { ...n, children: applyToNodes(n.children) };
      });
    }
    const newNodes = applyToNodes(currentDoc.nodes);
    const newHash = fakeHash(`patch_${pageId}_${patch.elementId}_${JSON.stringify(patch.value)}`);
    const updatedDoc = { ...currentDoc, nodes: newNodes, documentHash: newHash };
    const updated = { ...p, elementorDoc: updatedDoc, modifiedAt: new Date().toISOString() };
    this.pages.set(pageId, updated);
    return { resultToken: `tok_patch_${pageId}_${patch.elementId}`, afterStateHash: newHash };
  }

  async getElementorSnapshot(pageId: string): Promise<{ documentHash: string; rawNodes: unknown[] } | null> {
    this.log("getElementorSnapshot", [pageId]);
    const p = this.pages.get(pageId);
    if (!p) return null;
    const doc = p.elementorDoc ?? { pageId, version: "fake", documentHash: p.contentHash, nodes: [] };
    // Return a simplified raw representation (typed nodes without _preserved for fake)
    return { documentHash: doc.documentHash, rawNodes: doc.nodes as unknown[] };
  }

  async rollbackElementorDocument(pageId: string, params: ElementorBridgeRollback): Promise<WpWritePrimitive> {
    this.log("rollbackElementorDocument", [pageId, params]);
    if (this.config.offline) throw new Error("Site offline");
    const p = this.pages.get(pageId);
    if (!p) throw new Error(`Page ${pageId} not found`);
    const currentDoc = p.elementorDoc ?? { pageId, version: "fake", documentHash: p.contentHash, nodes: [] };
    if (currentDoc.documentHash !== params.expectedCurrentHash) {
      throw new Error(`conflict_detected: document changed since rollback was initiated`);
    }
    // Restore the snapshot nodes
    const restoredHash = fakeHash(`rollback_${pageId}_${JSON.stringify(params.elementorData)}`);
    const restoredDoc = { pageId, version: "fake", documentHash: restoredHash, nodes: params.elementorData as ElementorNode[] };
    const updated = { ...p, elementorDoc: restoredDoc, modifiedAt: new Date().toISOString() };
    this.pages.set(pageId, updated);
    return { resultToken: `tok_rollback_${pageId}`, afterStateHash: restoredHash };
  }

  async createRevisionSnapshot(pageId: string): Promise<{ snapshotToken: string; revisionId: string; contentHash: string }> {
    this.log("createRevisionSnapshot", [pageId]);
    if (this.config.offline) throw new Error("Site offline");
    const p = this.pages.get(pageId);
    if (!p) throw new Error(`Page ${pageId} not found`);
    const revisionId = `rev_${pageId}_${Date.now()}`;
    this.revisions.set(revisionId, { revisionId, contentHash: p.contentHash, doc: p.elementorDoc });
    return { snapshotToken: `snap_${revisionId}`, revisionId, contentHash: p.contentHash };
  }

  async restoreRevisionSnapshot(pageId: string, revisionId: string): Promise<WpWritePrimitive> {
    this.log("restoreRevisionSnapshot", [pageId, revisionId]);
    if (this.config.offline) throw new Error("Site offline");
    const rev = this.revisions.get(revisionId);
    if (!rev) throw new Error(`Revision ${revisionId} not found`);
    const p = this.pages.get(pageId);
    if (!p) throw new Error(`Page ${pageId} not found`);
    const restored = { ...p, contentHash: rev.contentHash, elementorDoc: rev.doc, modifiedAt: new Date().toISOString() };
    this.pages.set(pageId, restored);
    return { resultToken: `tok_restore_${revisionId}`, afterStateHash: rev.contentHash };
  }

  /** Expose current page state for test assertions. */
  getPageState(pageId: string): FakePageRecord | undefined {
    return this.pages.get(pageId);
  }

  private log(method: string, args: unknown[]) {
    this.callLog.push({ method, args });
  }
}

// ---------------------------------------------------------------------------
// Conflict simulation helper
// ---------------------------------------------------------------------------

/**
 * Simulate a conflict: the page's content hash doesn't match the expected value.
 * Used in tests to prove precondition enforcement works.
 */
export function simulateHumanEdit(adapter: FakeWordPressAdapter, pageId: string, newContent: string): void {
  const p = adapter.getPageState(pageId);
  if (!p) return;
  // Access the internal map via the adapter's public test interface
  (adapter as unknown as { pages: Map<string, FakePageRecord> }).pages.set(pageId, {
    ...p,
    contentHash: `human_edit_${fakeHash(newContent)}`,
    modifiedAt: new Date().toISOString(),
  });
}
