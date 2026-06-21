import {createBrowserClient} from '@supabase/ssr';
import type {SupabaseClient} from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

export function getSupabaseBrowserClient(): SupabaseClient {
    if (client) return client;
    const url = import.meta.env.PUBLIC_SUPABASE_URL as string;
    const anonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY as string;
    if (!url || !anonKey) {
        throw new Error('Supabase env vars are not configured.');
    }
    client = createBrowserClient(url, anonKey);
    return client;
}

