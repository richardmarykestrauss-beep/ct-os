#!/usr/bin/env node
/**
 * CTOS-004A Part Q — real-execution benchmark pipeline runner (scratch operational tooling, not a
 * committed CT-OS feature — lives under scripts/benchmark/, outside tsc's "src" include).
 *
 * Runs ONE agent job for real, through the exact same code path CT-OS's production gateway uses:
 *   buildExecutionRequest -> toProviderRequest -> ModelRouter.execute(createServerRegistry(env))
 * No Supabase, no browser UI, no stub providers — a real GeminiProvider call against the real
 * GEMINI_API_KEY from .env.local (same loader src/mcp/server.ts uses: never overwrites an already-set
 * env var, never logs a value). preferredProvider is pinned to "gemini" with no fallback, per the
 * user's explicit choice of provider for this benchmark.
 *
 * Each pipeline stage (Agent 01 Research -> 02 UX -> 03 Creative -> 04 SEO -> 05 Builder Plan ->
 * 06 QA -> 00 Orchestrator, once per project) is one invocation: reads a stage-input JSON (agent
 * identity, instructions, evidence-bearing input artifacts, knowledge, requiredOutputSchema) and
 * writes a stage-output JSON (every router attempt, the validated output, usage/latency) so each
 * real call can be inspected before the pipeline moves on. Real web evidence-gathering happens
 * OUTSIDE this script — this Gemini adapter has no browsing tool (see src/ai/providers/gemini.ts
 * file header) — and is baked into the stage input's instructions/inputArtifacts by the caller.
 *
 * Never commits, never mutates a website, never touches Supabase, never authenticates anywhere.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createServerRegistry } from "@/ai/registry";
import { ModelRouter } from "@/ai/router";
import { buildExecutionRequest, toProviderRequest } from "@/services/agent-jobs";
import { NoProviderAvailableError } from "@/ai/types";
import type { Agent, AgentJob, KnowledgeItem } from "@/data/types";
import type { ArtifactInput } from "@/ai/types";

function loadDotEnvLocal(root: string): void {
  const p = path.join(root, ".env.local");
  if (!existsSync(p)) return;
  const raw = readFileSync(p, "utf-8");
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (key && !(key in process.env)) process.env[key] = value;
  }
}

interface StageAgent {
  code: Agent["code"];
  shortCode: string;
  name: string;
  role: string;
  responsibilities: string[];
  requiredCapabilities: Agent["requiredCapabilities"];
  permissionLevel: Agent["permissionLevel"];
  defaultPriority?: Agent["defaultPriority"];
}

interface StageInput {
  runLabel: string;
  agent: StageAgent;
  taskType: AgentJob["taskType"];
  instructions: string;
  inputArtifacts: ArtifactInput[];
  knowledge: KnowledgeItem[];
  requiredOutputSchema: string;
}

async function main() {
  const root = process.cwd();
  loadDotEnvLocal(root);

  const inPath = process.argv[2];
  const outPath = process.argv[3];
  if (!inPath || !outPath) {
    console.error("usage: node run-stage.js <stage-input.json> <stage-output.json>");
    process.exitCode = 1;
    return;
  }
  const stage: StageInput = JSON.parse(readFileSync(inPath, "utf-8"));

  const registry = createServerRegistry(process.env);
  const router = new ModelRouter({ registry });

  const nowIso = new Date().toISOString();
  const job: AgentJob = {
    id: `bench_${Date.now()}`,
    projectId: "bench",
    agentId: stage.agent.code,
    taskType: stage.taskType,
    instructions: stage.instructions,
    inputArtifactIds: stage.inputArtifacts.map((a) => a.id),
    availableToolIds: [],
    requiredOutputSchema: stage.requiredOutputSchema,
    requiredCapabilities: stage.agent.requiredCapabilities,
    preferredProvider: "claude",
    fallbackProviders: [],
    executionPriority: stage.agent.defaultPriority ?? "BALANCED",
    permissionLevel: stage.agent.permissionLevel,
    status: "RUNNING",
    outputArtifactId: null,
    handoffId: null,
    requestedById: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    startedAt: nowIso,
    completedAt: null,
  };

  const agentFull: Agent = {
    id: stage.agent.code,
    code: stage.agent.code,
    shortCode: stage.agent.shortCode,
    name: stage.agent.name,
    role: stage.agent.role,
    responsibilities: stage.agent.responsibilities,
    status: "WORKING",
    lastRunAt: null,
    outputsProduced: 0,
    providerPolicy: { preferred: "gemini", fallbacks: [] },
    permissionLevel: stage.agent.permissionLevel,
    requiredCapabilities: stage.agent.requiredCapabilities,
    producesArtifactTypes: [],
    consumesArtifactTypes: [],
    canExecuteSiteChanges: false,
    defaultPriority: stage.agent.defaultPriority,
    createdAt: null,
    updatedAt: null,
  };

  const request = buildExecutionRequest({ job, agent: agentFull, inputArtifacts: stage.inputArtifacts, knowledge: stage.knowledge, skills: [] });
  const providerRequest = toProviderRequest(request);

  console.log(`[run-benchmark] ${stage.runLabel}: calling Gemini for ${stage.requiredOutputSchema}...`);
  const startedAt = Date.now();
  try {
    const result = await router.execute(providerRequest);
    const elapsedMs = Date.now() - startedAt;
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(
      outPath,
      JSON.stringify(
        {
          ok: true,
          runLabel: stage.runLabel,
          elapsedMs,
          providerId: result.providerId,
          model: result.response.model,
          usage: result.response.usage,
          finishReason: result.response.finishReason,
          output: result.output,
          attempts: result.attempts,
        },
        null,
        2,
      ),
      "utf-8",
    );
    console.log(`[run-benchmark] OK - ${result.providerId}/${result.response.model} in ${elapsedMs}ms - wrote ${outPath}`);
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    const attempts = err instanceof NoProviderAvailableError ? err.attempts : [];
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(
      outPath,
      JSON.stringify({ ok: false, runLabel: stage.runLabel, elapsedMs, error: err instanceof Error ? err.message : String(err), attempts }, null, 2),
      "utf-8",
    );
    console.error(`[run-benchmark] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

main();
