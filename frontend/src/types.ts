export interface Status {
  version: string;
  setup_complete: boolean;
  local: boolean;
  remote_access_enabled: boolean;
  authenticated: boolean;
  clock_24_hour: boolean;
  garbage_pickup_enabled: boolean;
  garbage_pickup_weekday: number;
  reduced_motion: boolean;
  time: string;
}

export interface CalendarEvent {
  id: number;
  calendar_id: number;
  calendar_name: string;
  color: string;
  title: string;
  description: string;
  location: string;
  starts_at: string;
  ends_at: string;
  all_day: number;
}

export interface Holiday {
  date: string;
  title: string;
  type: "holiday";
}

export interface Expiration {
  expires_on: string;
  product_id: number;
  name: string;
  quantity: number;
}

export interface CalendarData {
  events: CalendarEvent[];
  holidays: Holiday[];
  expirations: Expiration[];
}

export interface InventoryLot {
  id: number;
  product_id: number;
  quantity: number;
  expires_on: string | null;
  added_at: string;
}

export interface Product {
  id: number;
  name: string;
  normalized_name: string;
  brand: string;
  category: string;
  package_size: string;
  notes: string;
  source: string;
  image_url: string;
  nutrition?: Record<string, number | string>;
  ingredients: string;
  allergens: string;
  total_quantity: number;
  nearest_expiration: string | null;
  barcodes: string | { barcode: string }[] | null;
  lots: InventoryLot[];
}

export interface ShoppingItem {
  id: number;
  name: string;
  quantity: number;
  purchased: number;
  barcode: string | null;
}

export interface Reminder {
  id: number;
  text: string;
  completed: number;
}

export interface Timer {
  id: number;
  label: string;
  ends_at: string;
  status: "running" | "finished" | "dismissed";
}

export interface Weather {
  current: Record<string, number | string>;
  hourly: Record<string, Array<number | string>>;
  daily: Record<string, Array<number | string>>;
  units: { temperature: string; wind: string };
  attribution: string;
}

export interface WeatherAlert {
  alert_id: string;
  event: string;
  headline: string;
  description: string;
  instruction: string;
  severity: string;
  expires_at: string;
  dismissed: number;
}
