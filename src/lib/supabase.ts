import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { loadConfig } from './env.js';

let client: SupabaseClient | undefined;

export function getSupabase(): SupabaseClient {
  if (client) return client;

  const { supabaseUrl, supabaseServiceRoleKey } = loadConfig();
  client = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return client;
}
