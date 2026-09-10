/**
 * CTOS-006 Part 29: WordPress Write Engine tests.
 *
 * All tests use FakeWordPressAdapter — NO live WordPress connections.
 * No paid/live provider calls. No secrets.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { EMPTY } from "@/gateway/core";
import type { OSData, WpWriteAction, WpTargetRef, WpPrecondition, WordPressSiteConnection } from "@/data/types";
import {
  createChangePlan,
  approveChangePlan,
  executeChangePlan,
  rollbackWrite,
  createUProofSiteConnection,
  validateChangePlan,
} from "../wp-write-engine";
import type { WpEngineOptions } from "../wp-write-engine";
import {
  FakeWordPressAdapter,
  simulateHumanEdit,
} from "../wp-adapter";
import type { FakePageRecord } from "../wp-adapter";
import {
  actionPermissionTier,
  planPermissionTier,
  effectiveWpPermissionLevel,
  isSafeStyleKey,
  detectUnsafeContent,
  validateSafeUrl,
  isForbiddenAction,
} from "../wp-permissions";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const SITE_CONN_ID = "wsc_test_1";
const PROJECT_ID = "proj_test_1";
const PAGE_ID = "page_home";

const homePage: FakePageRecord = {
  id: PAGE_ID,
  title: "Home",
  slug: "home",
  status: "publish",
  modifiedAt: "2024-01-01T00:00:00Z",
  contentHash: "hash_original_abc",
  metaDescription: null,
  meta: {},
  elementorDoc: null,
};

const baseConn: WordPressSiteConnection = {
  id: SITE_CONN_ID,
  projectId: PROJECT_ID,
  siteUrl: "https://fake-wp.test",
  environment: "STAGING",
  cms: "WORDPRESS",
  builder: "ELEMENTOR_PRO",
  authMethod: "application_password",
  credentialsRef: null,
  connectionStatus: "ONLINE",
  lastVerifiedAt: null,
  capabilities: ["read_content", "write_draft", "read_elementor"],
  writeable: true,
  ownershipNote: null,
  hostProvider: "Hostinger",
  hostReplaceable: true,
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

function baseData(): OSData {
  return {
    ...EMPTY,
    wpSiteConnections: [baseConn],
  };
}

function makeTarget(overrides: Partial<WpTargetRef> = {}): WpTargetRef {
  return {
    pageId: PAGE_ID,
    templateId: null,
    elementorElementId: null,
    widgetId: null,
    containerId: null,
    sectionSemanticKey: null,
    contentSlotKey: null,
    ...overrides,
  };
}

function makePrecondition(expectedValue: string): WpPrecondition {
  return { kind: "content_value", expectedValue };
}

function makeAction(overrides: Partial<WpWriteAction> = {}): WpWriteAction {
  return {
    id: "act_001",
    type: "UPDATE_HEADING",
    permissionLevel: "GREEN",
    target: makeTarget(),
    preconditions: [makePrecondition("hash_original_abc")],
    payload: { field: "title", value: "New Heading" },
    idempotencyKey: `${PROJECT_ID}:${PAGE_ID}:UPDATE_HEADING:heading_1`,
    ...overrides,
  };
}

let idCounter = 0;
function makeOpts(): WpEngineOptions {
  return {
    newId: (prefix: string) => `${prefix}_${(++idCounter).toString().padStart(4, "0")}`,
    now: () => "2024-01-01T12:00:00Z",
    actorId: "actor_test",
    actorName: "Test Actor",
  };
}

// ---------------------------------------------------------------------------
// wp-permissions: unit tests
// ---------------------------------------------------------------------------

describe("wp-permissions", () => {
  describe("actionPermissionTier", () => {
    it("returns GREEN for all defined action types", () => {
      expect(actionPermissionTier("UPDATE_HEADING")).toBe("GREEN");
      expect(actionPermissionTier("CREATE_DRAFT_PAGE")).toBe("GREEN");
      expect(actionPermissionTier("REPLACE_IMAGE")).toBe("GREEN");
      expect(actionPermissionTier("UPDATE_META_DESCRIPTION")).toBe("GREEN");
    });

    it("returns RED for unknown action types", () => {
      expect(actionPermissionTier("UNKNOWN_ACTION" as never)).toBe("RED");
    });
  });

  describe("planPermissionTier", () => {
    it("returns GREEN when all actions are GREEN", () => {
      expect(planPermissionTier(["UPDATE_HEADING", "UPDATE_TEXT"])).toBe("GREEN");
    });

    it("returns RED if any action is unknown", () => {
      expect(planPermissionTier(["UPDATE_HEADING", "UNKNOWN" as never])).toBe("RED");
    });

    it("returns GREEN for empty list", () => {
      expect(planPermissionTier([])).toBe("GREEN");
    });
  });

  describe("effectiveWpPermissionLevel", () => {
    it("upgrades GREEN → AMBER on PRODUCTION", () => {
      expect(effectiveWpPermissionLevel("GREEN", "PRODUCTION")).toBe("AMBER");
    });

    it("does not upgrade GREEN on STAGING", () => {
      expect(effectiveWpPermissionLevel("GREEN", "STAGING")).toBe("GREEN");
    });

    it("keeps RED regardless of environment", () => {
      expect(effectiveWpPermissionLevel("RED", "STAGING")).toBe("RED");
      expect(effectiveWpPermissionLevel("RED", "PRODUCTION")).toBe("RED");
    });
  });

  describe("isSafeStyleKey", () => {
    it("allows the 13 whitelisted keys", () => {
      expect(isSafeStyleKey("color")).toBe(true);
      expect(isSafeStyleKey("text_align")).toBe(true);
      expect(isSafeStyleKey("typography_font_size")).toBe(true);
    });

    it("rejects unknown style keys", () => {
      expect(isSafeStyleKey("custom_css")).toBe(false);
      expect(isSafeStyleKey("z_index")).toBe(false);
    });
  });

  describe("detectUnsafeContent", () => {
    it("blocks javascript: URIs", () => {
      expect(detectUnsafeContent("javascript:alert(1)")).not.toBeNull();
    });

    it("blocks script tags", () => {
      expect(detectUnsafeContent("<script>evil()</script>")).not.toBeNull();
    });

    it("blocks inline event handlers", () => {
      expect(detectUnsafeContent('onclick=alert("xss")')).not.toBeNull();
    });

    it("blocks eval()", () => {
      expect(detectUnsafeContent("eval(document.cookie)")).not.toBeNull();
    });

    it("blocks SELECT FROM (SQL injection)", () => {
      expect(detectUnsafeContent("SELECT * FROM users")).not.toBeNull();
    });

    it("allows safe text content", () => {
      expect(detectUnsafeContent("Welcome to U-Proof")).toBeNull();
      expect(detectUnsafeContent("Contact us today!")).toBeNull();
    });
  });

  describe("validateSafeUrl", () => {
    it("allows https URLs", () => {
      expect(validateSafeUrl("https://example.com")).toBeNull();
    });

    it("allows http URLs", () => {
      expect(validateSafeUrl("http://example.com/page")).toBeNull();
    });

    it("blocks javascript: URLs", () => {
      expect(validateSafeUrl("javascript:alert(1)")).not.toBeNull();
    });

    it("blocks data: URIs", () => {
      expect(validateSafeUrl("data:text/html,<script>evil</script>")).not.toBeNull();
    });
  });

  describe("isForbiddenAction", () => {
    it("returns true for forbidden labels", () => {
      expect(isForbiddenAction("DELETE_PRODUCTION_PAGE")).toBe(true);
      expect(isForbiddenAction("INSTALL_PLUGIN")).toBe(true);
    });

    it("returns false for normal action type strings", () => {
      expect(isForbiddenAction("UPDATE_HEADING")).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// FakeWordPressAdapter: structural tests
// ---------------------------------------------------------------------------

describe("FakeWordPressAdapter", () => {
  it("returns ONLINE when unconfigured", async () => {
    const adapter = new FakeWordPressAdapter();
    const check = await adapter.verifyConnection();
    expect(check.online).toBe(true);
    expect(check.authOk).toBe(true);
  });

  it("simulates offline", async () => {
    const adapter = new FakeWordPressAdapter({ offline: true });
    const check = await adapter.verifyConnection();
    expect(check.online).toBe(false);
  });

  it("simulates auth failure", async () => {
    const adapter = new FakeWordPressAdapter({ authFail: true });
    const check = await adapter.verifyConnection();
    expect(check.authOk).toBe(false);
  });

  it("creates a draft page and returns it via getPage", async () => {
    const adapter = new FakeWordPressAdapter();
    const result = await adapter.createDraftPage({ title: "Test Page", slug: "test-page" });
    expect(result.pageId).toBeTruthy();
    const page = await adapter.getPage(result.pageId);
    expect(page?.title).toBe("Test Page");
    expect(page?.status).toBe("draft");
  });

  it("records call log", async () => {
    const adapter = new FakeWordPressAdapter({ pages: [homePage] });
    await adapter.getPage(PAGE_ID);
    expect(adapter.callLog.some((c) => c.method === "getPage")).toBe(true);
  });

  it("simulateHumanEdit changes contentHash", async () => {
    const adapter = new FakeWordPressAdapter({ pages: [homePage] });
    const before = await adapter.getPage(PAGE_ID);
    simulateHumanEdit(adapter, PAGE_ID, "someone typed something");
    const after = adapter.getPageState(PAGE_ID);
    expect(after?.contentHash).not.toBe(before?.contentHash);
  });
});

// ---------------------------------------------------------------------------
// createChangePlan: pure function tests
// ---------------------------------------------------------------------------

describe("createChangePlan", () => {
  it("creates a DRAFT plan with GREEN tier for staging", () => {
    const data = baseData();
    const result = createChangePlan(
      data,
      { projectId: PROJECT_ID, siteConnectionId: SITE_CONN_ID, sourceRequest: "Update hero heading", targetPageId: PAGE_ID, targetPageTitle: "Home", actions: [makeAction()] },
      makeOpts(),
    );
    const plan = result.data.websiteChangePlans[0];
    expect(plan.status).toBe("DRAFT");
    expect(plan.overallPermissionTier).toBe("GREEN");
    expect(plan.screenshotRequired).toBe(true);
  });

  it("derives AMBER tier when connection is PRODUCTION", () => {
    const data = baseData();
    data.wpSiteConnections[0] = { ...data.wpSiteConnections[0], environment: "PRODUCTION" };
    const result = createChangePlan(
      data,
      { projectId: PROJECT_ID, siteConnectionId: SITE_CONN_ID, sourceRequest: "Update heading", targetPageId: PAGE_ID, targetPageTitle: "Home", actions: [makeAction()] },
      makeOpts(),
    );
    const plan = result.data.websiteChangePlans[0];
    expect(plan.overallPermissionTier).toBe("AMBER");
  });

  it("falls back to STAGING environment when site connection not found", () => {
    const data = baseData();
    const result = createChangePlan(
      data,
      { projectId: PROJECT_ID, siteConnectionId: "missing_id", sourceRequest: "test", targetPageId: PAGE_ID, targetPageTitle: "Home", actions: [makeAction()] },
      makeOpts(),
    );
    // Engine doesn't throw — falls back to STAGING gracefully
    expect(result.plan.status).toBe("DRAFT");
    expect(result.plan.environment).toBe("STAGING");
  });

  it("creates a plan with empty actions (validation happens at execute time)", () => {
    const data = baseData();
    const result = createChangePlan(
      data,
      { projectId: PROJECT_ID, siteConnectionId: SITE_CONN_ID, sourceRequest: "test", targetPageId: PAGE_ID, targetPageTitle: "Home", actions: [] },
      makeOpts(),
    );
    expect(result.plan.actions).toHaveLength(0);
    expect(result.plan.backupRequired).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// approveChangePlan
// ---------------------------------------------------------------------------

describe("approveChangePlan", () => {
  it("moves plan from DRAFT to READY", () => {
    const data = baseData();
    const { data: data2 } = createChangePlan(
      data,
      { projectId: PROJECT_ID, siteConnectionId: SITE_CONN_ID, sourceRequest: "test", targetPageId: PAGE_ID, targetPageTitle: "Home", actions: [makeAction()] },
      makeOpts(),
    );
    const planId = data2.websiteChangePlans[0].id;
    const { data: data3, plan } = approveChangePlan(data2, planId, "approver_1", "Alice", makeOpts());
    expect(plan.status).toBe("READY");
    expect(plan.approvedById).toBe("approver_1");
    expect(data3.websiteChangePlans.find((p) => p.id === planId)?.status).toBe("READY");
  });
});

// ---------------------------------------------------------------------------
// executeChangePlan: integration tests using FakeWordPressAdapter
// ---------------------------------------------------------------------------

describe("executeChangePlan", () => {
  let adapter: FakeWordPressAdapter;
  let data: OSData;
  let planId: string;

  beforeEach(() => {
    adapter = new FakeWordPressAdapter({ pages: [homePage] });
    data = baseData();
    const createResult = createChangePlan(
      data,
      { projectId: PROJECT_ID, siteConnectionId: SITE_CONN_ID, sourceRequest: "Update heading", targetPageId: PAGE_ID, targetPageTitle: "Home", actions: [makeAction()] },
      makeOpts(),
    );
    data = createResult.data;
    planId = data.websiteChangePlans[0].id;
    const approveResult = approveChangePlan(data, planId, "approver_1", "Alice", makeOpts());
    data = approveResult.data;
  });

  it("executes a GREEN plan on STAGING and produces SUCCEEDED_VERIFIED", async () => {
    const result = await executeChangePlan(
      data,
      { planId },
      adapter,
      makeOpts(),
    );
    if (!result.ok) throw new Error(result.reason);
    const writeResult = result.data.websiteWriteResults[0];
    expect(writeResult.status).toBe("SUCCEEDED_VERIFIED");
    expect(writeResult.actionResults[0].status).toBe("SUCCEEDED");
    expect(result.data.wpIdempotencyLog.length).toBeGreaterThan(0);
    expect(result.data.wpWriteAuditLog.length).toBeGreaterThan(0);
    // Audit log must never contain secret-looking values
    const auditJson = JSON.stringify(result.data.wpWriteAuditLog[0]);
    expect(auditJson).not.toContain("password");
    expect(auditJson).not.toContain("api_key");
    expect(auditJson).not.toContain("Authorization");
  });

  it("fails with PRECONDITION_CONFLICT when human edits page before execution", async () => {
    simulateHumanEdit(adapter, PAGE_ID, "human typed this");
    const result = await executeChangePlan(
      data,
      { planId },
      adapter,
      makeOpts(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("PRECONDITION_CONFLICT");
  });

  it("idempotency log is populated and same action key fails on retry with a new plan", async () => {
    const first = await executeChangePlan(data, { planId }, adapter, makeOpts());
    if (!first.ok) throw new Error(first.reason);

    // Idempotency log populated
    expect(first.data.wpIdempotencyLog.length).toBeGreaterThan(0);
    const key = first.data.wpIdempotencyLog[0].idempotencyKey;
    expect(key).toBeTruthy();

    // A second plan with the same idempotency key on same project should fail
    const action2 = makeAction(); // same idempotencyKey
    const createResult2 = createChangePlan(
      first.data,
      { projectId: PROJECT_ID, siteConnectionId: SITE_CONN_ID, sourceRequest: "Duplicate", targetPageId: PAGE_ID, targetPageTitle: "Home", actions: [action2] },
      makeOpts(),
    );
    const approveResult2 = approveChangePlan(createResult2.data, createResult2.plan.id, "approver_1", "Alice", makeOpts());
    const second = await executeChangePlan(approveResult2.data, { planId: createResult2.plan.id }, adapter, makeOpts());
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("IDEMPOTENCY_DUPLICATE");
  });

  it("fails when adapter is offline", async () => {
    const offlineAdapter = new FakeWordPressAdapter({ offline: true });
    const result = await executeChangePlan(data, { planId }, offlineAdapter, makeOpts());
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// rollbackWrite
// ---------------------------------------------------------------------------

describe("rollbackWrite", () => {
  it("restores from a revision snapshot via writeResultId", async () => {
    const adapter = new FakeWordPressAdapter({ pages: [homePage] });
    const data = baseData();

    // Execute a plan so we have a writeResultId and a snapshot
    const createResult = createChangePlan(
      data,
      { projectId: PROJECT_ID, siteConnectionId: SITE_CONN_ID, sourceRequest: "Update heading", targetPageId: PAGE_ID, targetPageTitle: "Home", actions: [makeAction()] },
      makeOpts(),
    );
    const approveResult = approveChangePlan(createResult.data, createResult.plan.id, "approver_1", "Alice", makeOpts());
    const execResult = await executeChangePlan(approveResult.data, { planId: createResult.plan.id }, adapter, makeOpts());
    if (!execResult.ok) throw new Error(execResult.reason);

    const writeResultId = execResult.data.websiteWriteResults[0].id;

    // Now roll back
    const rollbackResult = await rollbackWrite(
      execResult.data,
      { writeResultId, actorId: "actor_test", actorName: "Test Actor" },
      adapter,
      makeOpts(),
    );
    expect(rollbackResult.ok).toBe(true);
    // Audit log should record the rollback
    expect(rollbackResult.data.wpWriteAuditLog.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// createUProofSiteConnection: config-only, no credentials, no writes
// ---------------------------------------------------------------------------

describe("createUProofSiteConnection", () => {
  it("creates a connection record with NO credential values", () => {
    const data = baseData();
    const result = createUProofSiteConnection(
      data,
      PROJECT_ID,
      {
        siteUrl: "https://uproof-client.test",
        environment: "STAGING",
        builder: "ELEMENTOR_PRO",
        authMethod: "application_password",
        credentialsRef: null,
        hostProvider: "Hostinger",
        notes: "Test onboarding",
      },
      makeOpts(),
    );
    const conn = result.connection;
    // CRITICAL: credentialsRef must be null — no credential value stored
    expect(conn.credentialsRef).toBeNull();
    // Status must be UNCHECKED — no connection was made
    expect(conn.connectionStatus).toBe("UNCHECKED");
    // Connection added to data
    expect(result.data.wpSiteConnections.some((c) => c.id === conn.id)).toBe(true);
    // Checklist has items
    expect(result.checklist.items.length).toBeGreaterThan(0);
  });

  it("never performs any writes to WordPress (pure function, no adapter)", () => {
    const data = baseData();
    // createUProofSiteConnection takes no adapter — it is purely config-only
    const result = createUProofSiteConnection(
      data,
      PROJECT_ID,
      {
        siteUrl: "https://test.test",
        environment: "STAGING",
        builder: "ELEMENTOR_PRO",
        authMethod: "application_password",
        credentialsRef: null,
        hostProvider: "Hostinger",
        notes: "Pure config test",
      },
      makeOpts(),
    );
    // Result contains data, connection, checklist — no ok/reason, no network calls
    expect(result.data).toBeTruthy();
    expect(result.connection).toBeTruthy();
    expect(result.checklist).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// ADD_APPROVED_SECTION enforcement (CTOS-006 Part 17)
// ---------------------------------------------------------------------------

describe("ADD_APPROVED_SECTION enforcement", () => {
  function makeSectionAction(libraryEntryId: string): WpWriteAction {
    return makeAction({
      id: "act_section",
      type: "ADD_APPROVED_SECTION",
      payload: { libraryEntryId, sectionNode: { id: "sec_1", type: "container", settings: {}, children: [], _preserved: {} } },
    });
  }

  function dataWithSection(status: "CANDIDATE" | "APPROVED" | "DEPRECATED"): OSData {
    return {
      ...baseData(),
      sectionLibrary: [{
        id: "sec_lib_001",
        name: "Hero Section",
        description: "Hero",
        category: "hero",
        status,
        buildStrategy: "LIBRARY_ASSEMBLY",
        evidence: [],
        approvedBy: status === "APPROVED" ? "admin" : null,
        approvedAt: status === "APPROVED" ? "2024-01-01T00:00:00Z" : null,
        createdAt: "2024-01-01T00:00:00Z",
      }],
    };
  }

  it("rejects CANDIDATE section", async () => {
    const data = dataWithSection("CANDIDATE");
    const { data: d1, plan } = createChangePlan(data, { projectId: PROJECT_ID, siteConnectionId: SITE_CONN_ID, sourceRequest: "test", actions: [makeSectionAction("sec_lib_001")] }, makeOpts());
    const d2 = approveChangePlan(d1, plan.id, "approver_1", "Admin", makeOpts());
    const result = validateChangePlan(d2.data, plan.id);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes("CANDIDATE"))).toBe(true);
  });

  it("rejects DRAFT section (unknown entry ID — not in library)", async () => {
    const data = dataWithSection("APPROVED");
    const { data: d1, plan } = createChangePlan(data, { projectId: PROJECT_ID, siteConnectionId: SITE_CONN_ID, sourceRequest: "test", actions: [makeSectionAction("sec_lib_UNKNOWN")] }, makeOpts());
    const d2 = approveChangePlan(d1, plan.id, "approver_1", "Admin", makeOpts());
    const result = validateChangePlan(d2.data, plan.id);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes("not found"))).toBe(true);
  });

  it("rejects DEPRECATED section", async () => {
    const data = dataWithSection("DEPRECATED");
    const { data: d1, plan } = createChangePlan(data, { projectId: PROJECT_ID, siteConnectionId: SITE_CONN_ID, sourceRequest: "test", actions: [makeSectionAction("sec_lib_001")] }, makeOpts());
    const d2 = approveChangePlan(d1, plan.id, "approver_1", "Admin", makeOpts());
    const result = validateChangePlan(d2.data, plan.id);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes("DEPRECATED"))).toBe(true);
  });

  it("accepts APPROVED section", async () => {
    const data = dataWithSection("APPROVED");
    const adapter = new FakeWordPressAdapter({ pages: [homePage] });
    const { data: d1, plan } = createChangePlan(data, { projectId: PROJECT_ID, siteConnectionId: SITE_CONN_ID, sourceRequest: "test", actions: [makeSectionAction("sec_lib_001")] }, makeOpts());
    const d2 = approveChangePlan(d1, plan.id, "approver_1", "Admin", makeOpts());
    const result = await executeChangePlan(d2.data, { planId: plan.id }, adapter, makeOpts());
    expect(result.ok).toBe(true);
  });

  it("rejects unknown section ID (missing libraryEntryId)", async () => {
    const data = baseData();
    const actionNoId = makeAction({ id: "act_noid", type: "ADD_APPROVED_SECTION", payload: { sectionNode: {} } });
    const { data: d1, plan } = createChangePlan(data, { projectId: PROJECT_ID, siteConnectionId: SITE_CONN_ID, sourceRequest: "test", actions: [actionNoId] }, makeOpts());
    const d2 = approveChangePlan(d1, plan.id, "approver_1", "Admin", makeOpts());
    const result = validateChangePlan(d2.data, plan.id);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes("libraryEntryId"))).toBe(true);
  });
});
