import type { AuthUser, OSData } from "@/data/types";
import { seedData } from "@/data/seed";

export const base = (): OSData => structuredClone(seedData);

export const lead: AuthUser = { id: "u_lead", email: "lead@creativetouch.test", displayName: "Production Lead", role: "PRODUCTION_LEAD" };
export const admin: AuthUser = { id: "u_admin", email: "admin@creativetouch.test", displayName: "Admin", role: "ADMIN" };
export const member: AuthUser = { id: "u_member", email: "member@creativetouch.test", displayName: "Team Member", role: "TEAM_MEMBER" };
export const viewer: AuthUser = { id: "u_viewer", email: "viewer@creativetouch.test", displayName: "Viewer", role: "VIEWER" };

export const ROLES_BY_ID: Record<string, AuthUser["role"]> = { u_lead: "PRODUCTION_LEAD", u_admin: "ADMIN", u_member: "TEAM_MEMBER", u_viewer: "VIEWER" };
