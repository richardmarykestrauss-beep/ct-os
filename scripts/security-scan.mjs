/**
 * Security scan (Part M): builds the frontend with canary secrets in the environment and proves
 * none of them — nor any server-only module — reaches the browser bundle.
 *   node scripts/security-scan.mjs
 */
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const canaries = {
  OPENAI_API_KEY: "sk-CANARY-openai-0000000000000000",
  ANTHROPIC_API_KEY: "sk-ant-CANARY-anthropic-000000000",
  GEMINI_API_KEY: "AIza-CANARY-gemini-00000000000000",
  SUPABASE_SERVICE_ROLE_KEY: "eyCANARY.service.role.key",
};
const env = { ...process.env, ...canaries, VITE_SUPABASE_URL: "https://canary.supabase.co", VITE_SUPABASE_ANON_KEY: "anon-public-key-is-allowed" };
// CTOS_SCAN_OUTDIR lets sandboxed environments build somewhere other than ./dist.
const outDir = process.env.CTOS_SCAN_OUTDIR || "dist";
execSync(`npx vite build${outDir !== "dist" ? ` --outDir ${JSON.stringify(outDir)}` : ""}`, { stdio: "inherit", env });

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const files = walk(outDir);
const problems = [];
for (const f of files) {
  const text = readFileSync(f, "utf8");
  for (const [name, value] of Object.entries(canaries)) if (text.includes(value)) problems.push(`${f}: contains the value of ${name}`);
  // Server-only markers that must never be bundled for the browser.
  for (const marker of ["SUPABASE_SERVICE_ROLE_KEY", "createNodeGatewayHandler", "Deno.env", "CTOS_ALLOW_STUB_PROVIDERS"]) if (text.includes(marker)) problems.push(`${f}: contains server-only marker "${marker}"`);
  if (/import\.meta\.env\.(OPENAI|ANTHROPIC|GEMINI)_API_KEY/.test(text)) problems.push(`${f}: reads a provider key from import.meta.env`);
}
if (problems.length) {
  console.error("SECURITY SCAN FAILED:\n" + problems.join("\n"));
  process.exit(1);
}
console.log(`Security scan passed: ${files.length} bundle files, no provider/service-role secret values, no server-only modules.`);
