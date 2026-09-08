import { describe, expect, it } from "vitest";
import { seedData } from "@/data/seed";
import { artifactLineage, createArtifact, createArtifactVersion, latestArtifact, outputSchemaFor } from "@/services/artifacts";

const base = () => structuredClone(seedData);

describe("artifact system", () => {
  it("creates version 1 with metadata and no claimed file", () => {
    const { data, artifact } = createArtifact(base(), { projectId: "proj_uproof", type: "site_blueprint", title: "Blueprint", createdByAgentId: "agent_02", createdByProvider: "claude" });
    expect(artifact.version).toBe(1);
    expect(artifact.status).toBe("DRAFT");
    expect(artifact.storageLocation).toBeNull();
    expect(artifact.supersedesArtifactId).toBeNull();
    expect(artifact.schemaVersion).toBe(1);
    expect(artifact.createdByProvider).toBe("claude");
    expect(data.artifacts.at(-1)).toEqual(artifact);
    expect(data.artifacts.length).toBe(seedData.artifacts.length + 1);
  });

  it("versions: new artifact supersedes the previous one and lineage is walkable", () => {
    const v1 = createArtifact(base(), { projectId: "proj_uproof", type: "content_pack", title: "Content", createdByAgentId: "agent_04" });
    const v2 = createArtifactVersion(v1.data, { previousArtifactId: v1.artifact.id, createdByAgentId: "agent_04", createdByProvider: "openai", summary: "revised" });
    expect(v2.artifact.version).toBe(2);
    expect(v2.artifact.supersedesArtifactId).toBe(v1.artifact.id);
    expect(v2.artifact.title).toBe("Content");
    expect(v2.data.artifacts.find((a) => a.id === v1.artifact.id)?.status).toBe("SUPERSEDED");
    expect(latestArtifact(v2.data, "proj_uproof", "content_pack")?.id).toBe(v2.artifact.id);
    const lineage = artifactLineage(v2.data, v2.artifact.id);
    expect(lineage.map((a) => a.version)).toEqual([2, 1]);
    // versioning from a superseded artifact is refused
    expect(() => createArtifactVersion(v2.data, { previousArtifactId: v1.artifact.id, createdByAgentId: "agent_04" })).toThrow(/superseded/);
  });

  it("seed artifacts are metadata records only and never invent dates", () => {
    for (const a of seedData.artifacts) {
      expect(a.storageLocation).toBeNull();
      expect(a.createdAt).toBeNull();
      expect(a.version).toBe(1);
    }
    expect(outputSchemaFor("qa_report")).toBe("qa_report@1");
  });
});
