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
  onscreen_keyboard_enabled: boolean;
  weather_effects: "off" | "subtle" | "full";
  background_preview: string;
  background_preview_effects: string[];
  display_awake_lock: boolean;
  mobile_dash_address: string;
  platform: string;
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
  notes: string;
}

export interface Product {
  id: number;
  name: string;
  normalized_name: string;
  brand: string;
  category: string;
  package_size: string;
  serving_size: string;
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
  high_priority: number;
  position: number;
}

export interface Timer {
  id: number;
  label: string;
  ends_at: string;
  created_at: string;
  status: "running" | "finished" | "dismissed";
}

export interface Weather {
  current: Record<string, number | string>;
  hourly: Record<string, Array<number | string>>;
  daily: Record<string, Array<number | string>>;
  units: {
    temperature: string;
    wind: string;
    precipitation?: string;
    pressure?: string;
    visibility?: string;
  };
  air_quality?: {
    current: Record<string, number | string>;
    units: Record<string, string>;
    attribution: string;
  } | null;
  latitude?: number;
  longitude?: number;
  timezone?: string;
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
  effective_at?: string;
  dismissed: number;
}

export interface RecipeIngredient {
  name: string;
  measure: string;
}

export interface HouseholdMember {
  id: number;
  name: string;
  color: string;
  position: number;
}

export interface PlannerMeal {
  id: number;
  planned_date: string;
  recipe_id: string | null;
  title: string;
  image_url: string;
  display_image?: string;
  position: number;
}

export interface PlannerChore {
  id: number;
  title: string;
  color: string;
  recurring: number;
  weekday: number | null;
  scheduled_date: string | null;
  planned_date: string;
  completed: boolean;
  completed_at: string | null;
  members: HouseholdMember[];
}

export interface PlannerNote {
  id: number;
  planned_date: string;
  text: string;
}

export interface PlannerWeek {
  start: string;
  end: string;
  meals: PlannerMeal[];
  chores: PlannerChore[];
  notes: PlannerNote[];
}

export interface Recipe {
  recipe_id: string;
  source: "themealdb" | "custom";
  title: string;
  category: string;
  area: string;
  image_url: string;
  image_data: string;
  ingredients: RecipeIngredient[];
  steps: string[];
  favorite: boolean;
  custom: boolean;
}
