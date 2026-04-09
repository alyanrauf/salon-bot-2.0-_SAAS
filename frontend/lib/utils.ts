import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(amount: number, currency = "Rs.") {
  return `${currency} ${amount.toLocaleString("en-PK")}`;
}

export function formatDate(dateStr: string) {
  if (!dateStr) return "—";
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function formatTime(timeStr: string) {
  if (!timeStr) return "—";
  const [h, m] = timeStr.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

export const STATUS_LABELS: Record<string, string> = {
  confirmed: "Confirmed",
  completed: "Completed",
  canceled: "Cancelled",
  no_show: "No-Show",
  archived: "Archived",
};

export const STATUS_COLORS: Record<string, string> = {
  confirmed: "bg-success-bg text-success",
  completed: "bg-info-bg text-info",
  canceled: "bg-danger-bg text-danger",
  no_show: "bg-neutral-bg text-neutral",
  archived: "bg-neutral-bg text-muted",
};

export const CHART_COLORS = [
  "#6366F1",
  "#EC4899",
  "#F59E0B",
  "#10B981",
  "#3B82F6",
  "#8B5CF6",
  "#EF4444",
  "#14B8A6",
];
