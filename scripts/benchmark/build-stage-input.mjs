#!/usr/bin/env node
/**
 * CTOS-004A Part Q — scratch helper. Assembles a run-stage.js stage-input JSON from a small
 * "spec" file plus previously-written stage-output JSONs, so a growing pipeline's accumulated
 * artifact content never has to be retyped by hand for each new stage.
 *
 * Usage: node build-stage-input.mjs <spec.json> <out-stage-in.json>
 *
 * spec.json shape:
 * {
 *   "runLabel": "...", "agent": {...}, "taskType": "...", "instructions": "...",
 *   "requiredOutputSchema": "...", "knowledgeFile": "knowledge.json",
 *   "inputs": [ { "file": "stage1-out.json", "id": "art_x", "type": "research_report", "title": "..." }, ... ]
 * }
 * All file paths are resolved relative to the spec file's own directory.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const specPath = process.argv[2];
const outPath = process.argv[3];
if (!specPath || !outPath) {
  console.error("usage: node build-stage-input.mjs <spec.json> <out-stage-in.json>");
  process.exit(1);
}
const dir = path.dirname(specPath);
const spec = JSON.parse(readFileSync(specPath, "utf-8"));

const inputArtifacts = (spec.inputs ?? []).map((ref) => {
  const raw = JSON.parse(readFileSync(path.join(dir, ref.file), "utf-8"));
  if (!raw.ok) throw new Error(`input stage ${ref.file} did not succeed: ${raw.error}`);
  return { id: ref.id, type: ref.type, version: ref.version ?? 1, title: ref.title, summary: raw.output.summary ?? null, content: raw.output };
});

const knowledge = spec.knowledgeFile ? JSON.parse(readFileSync(path.join(dir, spec.knowledgeFile), "utf-8")) : [];

const stage = {
  runLabel: spec.runLabel,
  agent: spec.agent,
  taskType: spec.taskType,
  instructions: spec.instructions,
  inputArtifacts,
  knowledge,
  requiredOutputSchema: spec.requiredOutputSchema,
};

writeFileSync(outPath, JSON.stringify(stage, null, 2), "utf-8");
console.log(`[build-stage-input] wrote ${outPath} (${inputArtifacts.length} input artifacts, ${knowledge.length} knowledge items)`);
