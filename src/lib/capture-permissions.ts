import type {SupabaseClient} from '@supabase/supabase-js';

export interface AuthorizedUser {
    id: string;
    email: string | null;
}

export async function requireUser(supabase: SupabaseClient): Promise<AuthorizedUser | null> {
    const {data: {user}} = await supabase.auth.getUser();
    if (!user) return null;
    return {id: user.id, email: user.email ?? null};
}

export async function userHasCaptureAccess(
    supabase: SupabaseClient,
    captureId: string,
): Promise<boolean> {
    const {data, error} = await supabase
        .from('capture_permissions')
        .select('capture_id')
        .eq('capture_id', captureId)
        .maybeSingle();
    if (error) return false;
    return !!data;
}

export interface CapturePermissionEntry {
    capture_id: string;
    role: string;
}

export async function listUserCaptures(supabase: SupabaseClient): Promise<CapturePermissionEntry[]> {
    const {data, error} = await supabase
        .from('capture_permissions')
        .select('capture_id, role, created_at')
        .order('created_at', {ascending: false});
    if (error || !data) return [];
    return data.map(r => ({capture_id: r.capture_id as string, role: r.role as string}));
}

export async function listUserCaptureIds(supabase: SupabaseClient): Promise<string[]> {
    const entries = await listUserCaptures(supabase);
    return entries.map(e => e.capture_id);
}

export async function getUserCaptureRole(
    supabase: SupabaseClient,
    captureId: string,
): Promise<string | null> {
    const {data, error} = await supabase
        .from('capture_permissions')
        .select('role')
        .eq('capture_id', captureId)
        .maybeSingle();
    if (error || !data) return null;
    return data.role as string;
}

export function isValidCaptureId(captureId: string): boolean {
    return /^[A-Za-z0-9_-]+$/.test(captureId);
}

export function unauthorizedResponse(message = 'Unauthorized.'): Response {
    return new Response(JSON.stringify({error: message}), {
        status: 401,
        headers: {'Content-Type': 'application/json'},
    });
}

export function forbiddenResponse(message = 'You do not have access to this capture.'): Response {
    return new Response(JSON.stringify({error: message}), {
        status: 403,
        headers: {'Content-Type': 'application/json'},
    });
}

