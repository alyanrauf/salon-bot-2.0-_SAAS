export interface Branch {
  id: number;
  number: number;
  name: string;
  address: string;
  map_link: string;
  phone: string;
}

export interface Staff {
  id: number;
  name: string;
  phone: string;
  role: string;
  branch_id: number | null;
  branch_name: string | null;
  status: "active" | "inactive";
}

export interface Service {
  id: number;
  name: string;
  price: string;
  description: string;
  branch: string;
  durationMinutes: number;
}

export interface Deal {
  id: number;
  title: string;
  description: string;
  active: 0 | 1;
}

export type BookingStatus = "confirmed" | "completed" | "canceled" | "no_show" | "archived";

export interface Booking {
  id: number;
  customer_name: string;
  phone: string;
  service: string;
  branch: string;
  date: string;        // YYYY-MM-DD
  time: string;        // HH:MM
  endTime?: string;    // HH:MM
  status: BookingStatus;
  notes?: string;
  staff_id?: number | null;
  staff_name?: string | null;
  staffRequested?: boolean;
  source?: string;
  created_at?: string;
}

export interface DashboardStats {
  total_bookings: number;
  today_bookings: number;
  active_services: number;
  total_clients: number;
  /** Metadata added in backend fix */
  queryRange?: { start: string; end: string; tz: string };
  dataFreshAsOf?: string;
  serverTime?: string;
}

export interface AnalyticsResponse {
  totalRevenue: number;
  bookingCount: number;
  topServices: Array<{ name: string; count: number; revenue: number }>;
  topDeals: Array<{ name: string; count: number }>;
  revenueByService: Array<{ name: string; revenue: number; percent: number }>;
  bookingsByBranch: Record<string, number>;
  queryRange?: { start: string; end: string; tz: string };
  filtersApplied?: Record<string, unknown>;
  dataFreshAsOf?: string;
  serverTime?: string;
}

export interface Client {
  customer_name: string;
  phone: string;
  booking_count: number;
  last_visit: string;
  status?: string;
}

export interface Role {
  id: number;
  name: string;
}

export interface SalonTimings {
  workday: { day_type: string; open_time: string; close_time: string } | null;
  weekend: { day_type: string; open_time: string; close_time: string } | null;
}

export interface Tenant {
  tenant_id: string;
  id?: string;
  salon_name: string;
  owner_name: string;
  email: string;
  phone: string;
  status: "active" | "suspended";
}
