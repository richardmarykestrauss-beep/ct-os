import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { PageHeader, SectionTitle } from "@/components/os/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { KnowledgeItem, KnowledgeScope, KnowledgeStatus, Skill, SkillStatus } from "@/data/types";
import { KNOWLEDGE_SCOPES } from "@/services/knowledge";
import { SKILL_KIND_LABELS, SKILL_STATUS_LABELS } from "@/services/skills";
import { agentById, useOS } from "@/state/os-store";
import { cn, formatRelative } from "@/lib/utils";
import { BookOpen, Check, X } from "lucide-react";

export const Route = createFileRoute("/knowledge")({ component: KnowledgePage });

type Filter = "candidates" | "approved" | "all";

const STATUS_TONE: Record<KnowledgeStatus, "warn" | "ok" | "danger" | "neutral"> = { CANDIDATE: "warn", APPROVED: "ok", REJECTED: "danger", DEPRECATED: "neutral" };
const STATUS_LABEL: Record<KnowledgeStatus, string> = { CANDIDATE: "Candidate", APPROVED: "Approved", REJECTED: "Rejected", DEPRECATED: "Deprecated" };

const SKILL_STATUS_TONE: Record<SkillStatus, "neutral" | "warn" | "ok" | "danger"> = { DRAFT: "neutral", CANDIDATE: "warn", APPROVED: "ok", DEPRECATED: "neutral", REJECTED: "danger" };
const SKILL_TABS: SkillStatus[] = ["DRAFT", "CANDIDATE", "APPROVED", "DEPRECATED"];

function KnowledgePage() {
  const { data, actions } = useOS();
  const [filter, setFilter] = React.useState<Filter>("candidates");
  const items = data.knowledgeItems.filter((k) => k.scope !== "TASK");
  const candidates = items.filter((k) => k.status === "CANDIDATE").length;
  const approved = items.filter((k) => k.status === "APPROVED").length;
  const visible = items.filter((k) => (filter === "candidates" ? k.status === "CANDIDATE" : filter === "approved" ? k.status === "APPROVED" : true));

  return (
    <>
      <PageHeader
        title="Knowledge"
        subtitle="What Creative Touch knows, by scope. Agents propose lessons; a human decides what becomes Agency knowledge."
        meta={
          <>
            <span className="text-xs text-muted">
              Candidates to review <span className="num ml-1 font-medium text-ink">{candidates}</span>
            </span>
            <span className="text-xs text-muted">
              Approved <span className="num ml-1 font-medium text-ink">{approved}</span>
            </span>
          </>
        }
        actions={
          <div className="flex flex-wrap gap-1">
            {(
              [
                ["candidates", "Needs review"],
                ["approved", "Approved"],
                ["all", "All"],
              ] as [Filter, string][]
            ).map(([key, label]) => (
              <button key={key} onClick={() => setFilter(key)} className={cn("rounded-md border px-2 py-0.5 text-xs", filter === key ? "border-accent bg-accent-soft text-accent-strong" : "border-border bg-surface text-muted hover:text-ink")}>
                {label}
              </button>
            ))}
          </div>
        }
      />

      {KNOWLEDGE_SCOPES.filter((s) => s.scope !== "TASK").map((scopeDef) => {
        const scoped = visible.filter((k) => k.scope === scopeDef.scope);
        if (!scoped.length && filter !== "all") return null;
        return (
          <section key={scopeDef.scope} className="mb-6">
            <SectionTitle right={<span className="text-[11px] text-muted">{scopeDef.description}</span>}>
              {scopeDef.label} <span className="num ml-1 text-muted">{scoped.length}</span>
            </SectionTitle>
            {scoped.length ? (
              <div className="grid gap-3 md:grid-cols-2">
                {scoped.map((k) => (
                  <KnowledgeCard key={k.id} item={k} onReview={(decision, scope, projectId) => actions.reviewKnowledge(k.id, decision, scope ? { scope, projectId } : undefined)} />
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed bg-surface px-4 py-6 text-center text-xs text-muted">Nothing in this scope yet.</div>
            )}
          </section>
        );
      })}

      <p className="flex items-center gap-1.5 text-[11px] text-muted">
        <BookOpen className="size-3.5" /> Approving records you as the reviewer. Agents cannot approve, and nothing here is sent to a provider until the item is approved.
      </p>

      <SectionTitle className="mt-6" right={<span className="text-[11px] text-muted">Reusable instruction packs and reviewed design/build skills (CTOS-003)</span>}>
        Skills
      </SectionTitle>
      <SkillsPanel />
    </>
  );
}

function SkillsPanel() {
  const { data } = useOS();
  const [tab, setTab] = React.useState<SkillStatus>("CANDIDATE");
  const bySkillStatus = data.skills.filter((s) => s.status === tab);
  return (
    <>
      <div className="mb-3 flex flex-wrap gap-1">
        {SKILL_TABS.map((s) => (
          <button key={s} onClick={() => setTab(s)} className={cn("rounded-md border px-2 py-0.5 text-xs", tab === s ? "border-accent bg-accent-soft text-accent-strong" : "border-border bg-surface text-muted hover:text-ink")}>
            {SKILL_STATUS_LABELS[s]} <span className="num ml-1">{data.skills.filter((x) => x.status === s).length}</span>
          </button>
        ))}
      </div>
      {bySkillStatus.length ? (
        <div className="grid gap-3 md:grid-cols-2">
          {bySkillStatus.map((s) => (
            <SkillCard key={s.id} skill={s} />
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed bg-surface px-4 py-6 text-center text-xs text-muted">No {SKILL_STATUS_LABELS[tab].toLowerCase()} skills.</div>
      )}
    </>
  );
}

function SkillCard({ skill }: { skill: Skill }) {
  const { data } = useOS();
  const owners = skill.ownerAgentIds.map((id) => agentById(data, id)?.shortCode ?? id).join(", ");
  const reviewers = skill.reviewerAgentIds.map((id) => agentById(data, id)?.shortCode ?? id).join(", ");
  return (
    <Card className="px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="text-[13px] font-semibold text-ink">
          {skill.name} <span className="font-mono text-[11px] text-muted">v{skill.version}</span>
        </div>
        <Badge tone={SKILL_STATUS_TONE[skill.status]}>{SKILL_STATUS_LABELS[skill.status]}</Badge>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
        <Badge tone="outline">{SKILL_KIND_LABELS[skill.kind]}</Badge>
        <span>· scope: {skill.scope}</span>
        {owners ? <span>· owner: {owners}</span> : null}
        {reviewers ? <span>· reviewer: {reviewers}</span> : null}
      </div>
      <p className="mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap text-xs text-ink-2">{skill.content}</p>
      {skill.evidence.length ? (
        <div className="mt-2 text-[11px] text-muted">
          Evidence: <span className="font-mono text-ink-2">{skill.evidence.join(" · ")}</span>
        </div>
      ) : null}
      {skill.approvedBy ? (
        <div className="mt-2 text-[11px] text-muted">
          Approved by {skill.approvedBy} {skill.approvedAt ? `· ${formatRelative(skill.approvedAt)}` : ""}
        </div>
      ) : (
        <div className="mt-2 text-[11px] text-faint">Only a human (Admin or Production Lead) can approve — see Settings for who can review.</div>
      )}
    </Card>
  );
}

function KnowledgeCard({ item, onReview }: { item: KnowledgeItem; onReview: (decision: "APPROVED" | "REJECTED" | "DEPRECATED", scope?: Exclude<KnowledgeScope, "TASK">, projectId?: string | null) => void }) {
  const { data } = useOS();
  const proposer = agentById(data, item.proposedByAgentId);
  const project = item.projectId ? data.projects.find((p) => p.id === item.projectId) : null;
  const lesson = data.agentLessons.find((l) => l.knowledgeItemId === item.id);
  return (
    <Card className="px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="text-[13px] font-semibold text-ink">{item.title}</div>
        <Badge tone={STATUS_TONE[item.status]}>{STATUS_LABEL[item.status]}</Badge>
      </div>
      <p className="mt-1.5 text-xs text-ink-2">{item.content}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
        <Badge tone="outline">{item.category}</Badge>
        <span className="num">confidence {Math.round(item.confidence * 100)}%</span>
        {proposer ? (
          <span>
            · proposed by <span className="font-mono">{proposer.shortCode}</span> {proposer.name}
          </span>
        ) : (
          <span>· human-authored</span>
        )}
        {project ? <span>· {project.name}</span> : null}
        {lesson?.source ? <span className="basis-full text-faint">Source: {lesson.source}</span> : null}
      </div>
      {item.evidence.length ? (
        <div className="mt-2 text-[11px] text-muted">
          Evidence: <span className="font-mono text-ink-2">{item.evidence.join(" · ")}</span>
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {item.status === "CANDIDATE" ? (
          <>
            <Button size="sm" variant="accent" onClick={() => onReview("APPROVED")}>
              <Check /> Approve as {item.scope === "AGENCY" ? "Agency" : "Project"} knowledge
            </Button>
            {item.scope === "AGENCY" && item.projectId === null && lesson?.projectId ? (
              <Button size="sm" variant="outline" onClick={() => onReview("APPROVED", "PROJECT", lesson.projectId)} title="Keep it to the project it came from">
                Approve for project only
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => onReview("REJECTED")}>
              <X /> Reject
            </Button>
          </>
        ) : item.status === "APPROVED" && item.scope !== "DOCTRINE" ? (
          <Button size="sm" variant="ghost" onClick={() => onReview("DEPRECATED")}>
            Deprecate
          </Button>
        ) : null}
        {item.reviewedBy ? (
          <span className="ml-auto text-[11px] text-muted">
            {item.reviewedBy} · {item.reviewedAt ? formatRelative(item.reviewedAt) : "time not recorded"}
          </span>
        ) : null}
      </div>
    </Card>
  );
}
