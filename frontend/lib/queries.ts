/** Centralized query keys + fetcher functions for TanStack Query */
import { api } from "./api";
import type {
  AnalyticsResponse,
  Booking,
  Branch,
  Client,
  DashboardStats,
  Deal,
  Role,
  SalonTimings,
  Service,
  Staff,
  Tenant,
} from "./types";

const BASE = "/salon-admin/api";

// ─── Query Keys ────────────────────────────────────────────────────────────
export const QK = {
  stats: (tz?: string) => ["stats", tz] as const,
  analytics: (params: Record<string, string | undefined>) =>
    ["analytics", params] as const,
  bookings: (params?: Record<string, string | undefined>) =>
    ["bookings", params ?? {}] as const,
  services: () => ["services"] as const,
  deals: () => ["deals"] as const,
  branches: () => ["branches"] as const,
  staff: () => ["staff"] as const,
  roles: () => ["roles"] as const,
  timings: () => ["timings"] as const,
  general: () => ["general"] as const,
  clients: () => ["clients"] as const,
  salonName: () => ["salonName"] as const,
  salonConfig: (tenantId: string) => ["salonConfig", tenantId] as const,
};

// ─── Fetchers ───────────────────────────────────────────────────────────────
export const fetchStats = (tz?: string) =>
  api.get<DashboardStats>(`${BASE}/stats${tz ? `?tz=${encodeURIComponent(tz)}` : ""}`);

export const fetchAnalytics = (params: Record<string, string | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") q.set(k, v);
  }
  return api.get<AnalyticsResponse>(`${BASE}/analytics?${q.toString()}`);
};

export const fetchBookings = (params?: Record<string, string | undefined>) => {
  const q = new URLSearchParams();
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") q.set(k, v);
    }
  }
  const qs = q.toString();
  return api.get<Booking[]>(`${BASE}/bookings${qs ? `?${qs}` : ""}`);
};

export const fetchServices = () => api.get<Service[]>(`${BASE}/services`);
export const fetchDeals = () => api.get<Deal[]>(`${BASE}/deals`);
export const fetchBranches = () => api.get<Branch[]>(`${BASE}/settings/branches`);
export const fetchStaff = () => api.get<Staff[]>(`${BASE}/settings/staff`);
export const fetchRoles = () => api.get<Role[]>(`${BASE}/settings/roles`);
export const fetchTimings = () => api.get<SalonTimings>(`${BASE}/settings/timings`);
export const fetchGeneral = () =>
  api.get<{ currency: string; timezone?: string; tenantId?: string; owner_name?: string | null }>(`${BASE}/settings/general`);
export const fetchClients = () => api.get<Client[]>(`${BASE}/clients`);

export const fetchSalonConfig = (tenantId: string) =>
  api.get<{ salon_name: string; bot_name: string; primary_color: string }>(
    `/salon-config/${encodeURIComponent(tenantId)}`
  );

// Super admin
const SA = "/super-admin/api";
export const fetchTenants = () => api.get<Tenant[]>(`${SA}/tenants`);
export const fetchSuperStats = () =>
  api.get<{ total_tenants: number; active_tenants: number }>(`${SA}/stats`);
