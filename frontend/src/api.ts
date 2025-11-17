import axios from "axios";

const DEFAULT_API_BASE = "http://127.0.0.1:8004";
const resolveFallbackOrigin = () => {
  if (typeof window === "undefined") {
    return DEFAULT_API_BASE;
  }
  const { origin, port } = window.location;
  // When running via Vite dev server (5173), default to backend on 8000.
  if (port === "5173" || port === "4173") {
    return DEFAULT_API_BASE;
  }
  return origin;
};

const fallbackOrigin = resolveFallbackOrigin();
const rawBase = import.meta.env.VITE_API_BASE || "";
const normalizedBase = rawBase
  ? rawBase.startsWith("http")
    ? rawBase
    : `${fallbackOrigin.replace(/\/$/, "")}${rawBase}`
  : fallbackOrigin;
export const API_BASE = normalizedBase.replace(/\/$/, "");

export interface Profile {
  id: number;
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export type SessionStatus = "running" | "completed" | "stopped" | "error" | "interrupted";

export interface SessionInfo {
  session_id: string;
  profile: Profile;
  status: SessionStatus;
  exit_code?: number | null;
  cwd?: string | null;
  log_path: string;
  created_at: string;
  finished_at?: string | null;
}

export interface SessionSummary extends SessionInfo {}

export interface GitStatusItem {
  status: string;
  path: string;
}

export interface GitChanges {
  git: boolean;
  message?: string;
  status?: GitStatusItem[];
  diff_stat?: string | null;
}

export interface LogResponse {
  session_id: string;
  content: string;
  historical: boolean;
  message?: string;
}

export interface SessionCreateResponse {
  sessions: SessionInfo[];
}

const client = axios.create({
  baseURL: API_BASE,
  timeout: 15000,
  headers: { "Content-Type": "application/json" },
});

export const api = {
  fetchProfiles: async () => {
    const { data } = await client.get<Profile[]>("/profiles");
    return data;
  },
  createProfile: async (payload: Partial<Profile>) => {
    const body = {
      name: payload.name,
      command: payload.command,
      args: payload.args ?? [],
      cwd: payload.cwd,
      env: payload.env ?? {},
    };
    const { data } = await client.post<Profile>("/profiles", body);
    return data;
  },
  updateProfile: async (id: number, payload: Partial<Profile>) => {
    const body = {
      name: payload.name,
      command: payload.command,
      args: payload.args,
      cwd: payload.cwd,
      env: payload.env,
    };
    const { data } = await client.put<Profile>(`/profiles/${id}`, body);
    return data;
  },
  deleteProfile: async (id: number) => client.delete(`/profiles/${id}`),
  listSessions: async () => {
    const { data } = await client.get<SessionSummary[]>("/sessions");
    return data;
  },
  createSession: async (profileId: number, quantity = 1) => {
    const body = { profile_id: profileId, quantity };
    const { data } = await client.post<SessionCreateResponse>("/sessions", body);
    return data.sessions;
  },
  fetchLogs: async (sessionId: string) => {
    const { data } = await client.get<LogResponse>(`/logs/${sessionId}`);
    return data;
  },
  fetchGitChanges: async (sessionId: string) => {
    const { data } = await client.get<GitChanges>(`/git_changes/${sessionId}`);
    return data;
  },
  deleteSession: async (sessionId: string) => client.delete(`/sessions/${sessionId}`),
};

export const websocketUrl = (sessionId: string) => {
  const base = API_BASE.startsWith("http") ? API_BASE : fallbackOrigin;
  const url = new URL(base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/ws/sessions/${sessionId}`;
  url.search = "";
  return url.toString();
};
