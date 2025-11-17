import axios from "axios";

const DEFAULT_API_BASE = "http://127.0.0.1:8001";
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

export interface SessionResponse {
  session_id: string;
  profile: Profile;
  cwd: string;
  log_path: string;
}

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
  createSession: async (profileId: number) => {
    const { data } = await client.post<SessionResponse>("/sessions", { profile_id: profileId });
    return data;
  },
  fetchLogs: async (sessionId: string) => {
    const { data } = await client.get<LogResponse>(`/logs/${sessionId}`);
    return data;
  },
  fetchGitChanges: async (sessionId: string) => {
    const { data } = await client.get<GitChanges>(`/git_changes/${sessionId}`);
    return data;
  },
};

export const websocketUrl = (sessionId: string) => {
  const base = API_BASE.startsWith("http") ? API_BASE : fallbackOrigin;
  const url = new URL(base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/ws/sessions/${sessionId}`;
  url.search = "";
  return url.toString();
};
