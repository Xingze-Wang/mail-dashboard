// Tiny wrapper around the system_config table so scorer routes don't each
// re-invent read/write logic. Everything is { key: string, value: jsonb }.

import { supabase } from "@/lib/db";

export async function getConfig<T = unknown>(key: string): Promise<T | null> {
  const { data } = await supabase
    .from("system_config")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  return (data?.value ?? null) as T | null;
}

export async function setConfig<T = unknown>(key: string, value: T): Promise<boolean> {
  const { data: existing } = await supabase
    .from("system_config")
    .select("key")
    .eq("key", key)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from("system_config")
      .update({ value, updated_at: new Date().toISOString() })
      .eq("key", key);
    return !error;
  }
  const { error } = await supabase
    .from("system_config")
    .insert({ key, value });
  return !error;
}
