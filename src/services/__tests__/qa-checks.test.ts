import { describe, it, expect } from "vitest";
import {
  detectPlaceholderContent,
  classifyLink,
  checkLinks,
} from "../qa-checks";
import type { ConsoleErrorRecord } from "../qa-checks";

// ---------------------------------------------------------------------------
// detectPlaceholderContent
// ---------------------------------------------------------------------------

describe("detectPlaceholderContent — clean text", () => {
  it("returns empty array for clean text", () => {
    expect(detectPlaceholderContent("Welcome to our shop. Browse our products.")).toEqual([]);
  });
});

describe("detectPlaceholderContent — lorem ipsum", () => {
  it("detects 'Lorem ipsum'", () => {
    const results = detectPlaceholderContent("Some intro text. Lorem ipsum dolor sit amet.");
    expect(results.some((r) => r.kind === "lorem_ipsum")).toBe(true);
  });

  it("is case-insensitive", () => {
    const results = detectPlaceholderContent("LOREM IPSUM");
    expect(results.some((r) => r.kind === "lorem_ipsum")).toBe(true);
  });
});

describe("detectPlaceholderContent — TODO / FIXME", () => {
  it("detects TODO", () => {
    const results = detectPlaceholderContent("<!-- TODO: replace with real copy -->");
    expect(results.some((r) => r.kind === "todo_comment")).toBe(true);
  });

  it("detects FIXME", () => {
    const results = detectPlaceholderContent("FIXME: this needs work");
    expect(results.some((r) => r.kind === "fixme_comment")).toBe(true);
  });

  it("does not false-positive on 'todo' inside a word like 'pseudocodo'", () => {
    // 'pseudocodo' does not contain 'TODO' as a word boundary
    const results = detectPlaceholderContent("pseudocodo is not a TODO trigger");
    // should only match the standalone TODO
    const todos = results.filter((r) => r.kind === "todo_comment");
    expect(todos[0]?.match).toBe("TODO");
  });
});

describe("detectPlaceholderContent — placeholder text", () => {
  it("detects placeholder", () => {
    const results = detectPlaceholderContent('<input placeholder="Enter value">');
    expect(results.some((r) => r.kind === "placeholder_text")).toBe(true);
  });
});

describe("detectPlaceholderContent — emails", () => {
  it("detects test@test email", () => {
    const results = detectPlaceholderContent("Contact: test@test.com");
    expect(results.some((r) => r.kind === "test_email")).toBe(true);
  });

  it("detects example.com email", () => {
    const results = detectPlaceholderContent("Email user@example.com for info.");
    expect(results.some((r) => r.kind === "example_email")).toBe(true);
  });
});

describe("detectPlaceholderContent — dummy phones", () => {
  it("detects 555-1234 style phone", () => {
    const results = detectPlaceholderContent("Call 555-1234 today");
    expect(results.some((r) => r.kind === "dummy_phone")).toBe(true);
  });
});

describe("detectPlaceholderContent — hash navigation", () => {
  it("detects href='#'", () => {
    const results = detectPlaceholderContent('<a href="#">Click here</a>');
    expect(results.some((r) => r.kind === "hash_navigation")).toBe(true);
  });

  it("does not flag real anchor links", () => {
    const results = detectPlaceholderContent('<a href="#section-1">Jump to section</a>');
    expect(results.filter((r) => r.kind === "hash_navigation")).toHaveLength(0);
  });
});

describe("detectPlaceholderContent — returns evidence not boolean", () => {
  it("includes match and context fields", () => {
    const results = detectPlaceholderContent("Lorem ipsum dolor sit amet.");
    expect(results[0]).toMatchObject({
      kind: "lorem_ipsum",
      match: expect.any(String),
      context: expect.any(String),
    });
  });

  it("context is trimmed and non-empty", () => {
    const results = detectPlaceholderContent("Some prefix text. Lorem ipsum suffix.");
    const r = results.find((x) => x.kind === "lorem_ipsum");
    expect(r?.context.length).toBeGreaterThan(0);
    expect(r?.context.trim()).toBe(r?.context);
  });
});

// ---------------------------------------------------------------------------
// classifyLink
// ---------------------------------------------------------------------------

const KNOWN = ["/", "/about", "/shop", "/contact"];

describe("classifyLink — fragment only", () => {
  it("classifies '#' as fragment_only", () => {
    expect(classifyLink("#", KNOWN)).toBe("fragment_only");
  });

  it("classifies '#section' as fragment_only", () => {
    expect(classifyLink("#section-2", KNOWN)).toBe("fragment_only");
  });
});

describe("classifyLink — external", () => {
  it("classifies https:// as external", () => {
    expect(classifyLink("https://example.com", KNOWN)).toBe("external");
  });

  it("classifies http:// as external", () => {
    expect(classifyLink("http://example.com/page", KNOWN)).toBe("external");
  });

  it("classifies protocol-relative as external", () => {
    expect(classifyLink("//cdn.example.com/img.png", KNOWN)).toBe("external");
  });

  it("classifies mailto: as external", () => {
    expect(classifyLink("mailto:info@site.com", KNOWN)).toBe("external");
  });
});

describe("classifyLink — valid internal", () => {
  it("classifies known path as valid_internal", () => {
    expect(classifyLink("/about", KNOWN)).toBe("valid_internal");
  });

  it("classifies root as valid_internal", () => {
    expect(classifyLink("/", KNOWN)).toBe("valid_internal");
  });

  it("strips query string before checking known pages", () => {
    expect(classifyLink("/shop?sort=price", KNOWN)).toBe("valid_internal");
  });

  it("strips hash before checking known pages", () => {
    expect(classifyLink("/about#team", KNOWN)).toBe("valid_internal");
  });
});

describe("classifyLink — unresolved internal", () => {
  it("classifies unknown /path as unresolved_internal", () => {
    expect(classifyLink("/products/widget", KNOWN)).toBe("unresolved_internal");
  });
});

describe("classifyLink — malformed", () => {
  it("classifies empty string as malformed", () => {
    expect(classifyLink("", KNOWN)).toBe("malformed");
  });

  it("classifies relative path without / as malformed", () => {
    expect(classifyLink("about.html", KNOWN)).toBe("malformed");
  });
});

// ---------------------------------------------------------------------------
// checkLinks
// ---------------------------------------------------------------------------

describe("checkLinks", () => {
  it("classifies a batch of links", () => {
    const results = checkLinks([
      { url: "/about", text: "About" },
      { url: "#", text: "Hash" },
      { url: "https://external.com", text: "External" },
      { url: "/missing-page", text: "404" },
    ], KNOWN);
    expect(results).toHaveLength(4);
    expect(results[0]?.classification).toBe("valid_internal");
    expect(results[1]?.classification).toBe("fragment_only");
    expect(results[2]?.classification).toBe("external");
    expect(results[3]?.classification).toBe("unresolved_internal");
  });

  it("preserves text field when provided", () => {
    const [r] = checkLinks([{ url: "/about", text: "About Us" }], KNOWN);
    expect(r?.text).toBe("About Us");
  });

  it("returns empty array for empty input", () => {
    expect(checkLinks([], KNOWN)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ConsoleErrorRecord type — structural check
// ---------------------------------------------------------------------------

describe("ConsoleErrorRecord type contract", () => {
  it("accepts a typed error record", () => {
    const record: ConsoleErrorRecord = {
      kind: "error",
      message: "Uncaught TypeError: Cannot read property 'foo' of undefined",
      source: "main.js",
      lineNumber: 42,
    };
    expect(record.kind).toBe("error");
    expect(record.message).toBeTruthy();
  });

  it("accepts warning and info kinds", () => {
    const warn: ConsoleErrorRecord = { kind: "warning", message: "Deprecated API used" };
    const info: ConsoleErrorRecord = { kind: "info", message: "Page loaded" };
    expect(warn.kind).toBe("warning");
    expect(info.kind).toBe("info");
  });

  it("empty console array means clean — not unchecked", () => {
    const consoleLogs: ConsoleErrorRecord[] = [];
    expect(consoleLogs).toHaveLength(0);
    // The empty array is valid evidence of a clean console
    const errors = consoleLogs.filter((r) => r.kind === "error");
    expect(errors).toHaveLength(0);
  });
});
