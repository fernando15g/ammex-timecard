import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Owner sign-in. Supabase is used ONLY for authentication — all app data stays
// in Notion. The session lives in localStorage, so it survives hard-closing the
// PWA and restarting the phone; the owner signs in once, not every session.
//
// Email + password on purpose, NOT magic links: a magic link opens in Safari
// rather than the home-screen PWA container, and the two have separate storage.
// The session would land in the wrong place and the app would still look
// logged out.

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

// True only when both env vars are present. When false the app behaves exactly
// as it did before auth existed — the PIN is the only gate. That is the
// permanent fallback, not a temporary one: a paused free-tier project or a
// Supabase outage must never lock the owner out of his own app.
export const authConfigured = Boolean(url && key);

let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient | null {
  if (!authConfigured) return null;
  if (!client) {
    client = createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false, // no magic-link redirects to parse
      },
    });
  }
  return client;
}

// The roster name that requires a password. Everyone else selects normally.
export const OWNER_FOREMAN =
  process.env.NEXT_PUBLIC_OWNER_FOREMAN || "Fernando Garcia";

export function isOwnerName(name: string): boolean {
  const norm = (s: string) =>
    (s || "").normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
  return norm(name) === norm(OWNER_FOREMAN);
}
