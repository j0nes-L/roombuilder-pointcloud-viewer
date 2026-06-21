import {createServerClient, parseCookieHeader, serializeCookieHeader} from '@supabase/ssr';
import type {AstroCookies} from 'astro';

function parseCookies(cookieHeader: string): {name: string; value: string}[] {
    return parseCookieHeader(cookieHeader)
        .filter((c): c is {name: string; value: string} => c.value !== undefined);
}

export function createSupabaseServerClient(cookies: AstroCookies, requestCookieHeader = '') {
    const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL as string;
    const supabaseAnonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY as string;

    return createServerClient(supabaseUrl, supabaseAnonKey, {
        cookies: {
            getAll() {
                return parseCookies(requestCookieHeader);
            },
            setAll(cookiesToSet) {
                cookiesToSet.forEach(({name, value, options}) =>
                    cookies.set(name, value, options)
                );
            },
        },
    });
}

export function createSupabaseServerClientFromRequest(request: Request, responseHeaders: Headers) {
    const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL as string;
    const supabaseAnonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY as string;

    return createServerClient(supabaseUrl, supabaseAnonKey, {
        cookies: {
            getAll() {
                return parseCookies(request.headers.get('Cookie') ?? '');
            },
            setAll(cookiesToSet) {
                cookiesToSet.forEach(({name, value, options}) => {
                    responseHeaders.append('Set-Cookie', serializeCookieHeader(name, value, options));
                });
            },
        },
    });
}
