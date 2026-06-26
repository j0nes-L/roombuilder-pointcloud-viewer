import type {APIRoute} from 'astro';
import {createSupabaseServerClientFromRequest} from '../../../lib/supabase-server';

export const POST: APIRoute = async ({request}) => {
    const responseHeaders = new Headers({'Content-Type': 'application/json'});
    const supabase = createSupabaseServerClientFromRequest(request, responseHeaders);

    let body: {email?: string; password?: string};
    try {
        body = await request.json();
    } catch {
        return new Response(JSON.stringify({error: 'Invalid request body.'}), {
            status: 400,
            headers: {'Content-Type': 'application/json'},
        });
    }

    const {email, password} = body;
    if (!email || !password) {
        return new Response(JSON.stringify({error: 'Email and password required.'}), {
            status: 400,
            headers: {'Content-Type': 'application/json'},
        });
    }

    const {data, error} = await supabase.auth.signInWithPassword({email, password});

    if (error || !data.session) {
        return new Response(JSON.stringify({error: error?.message ?? 'Login failed.'}), {
            status: 401,
            headers: {'Content-Type': 'application/json'},
        });
    }

    if (!data.user.email_confirmed_at) {
        await supabase.auth.signOut({scope: 'local'});
        return new Response(JSON.stringify({
            error: 'Email not confirmed. Please check your inbox and confirm your email address before logging in.',
        }), {
            status: 403,
            headers: {'Content-Type': 'application/json'},
        });
    }

    const {data: profile} = await supabase
        .from('profiles')
        .select('display_name')
        .eq('id', data.user.id)
        .single();

    responseHeaders.set('Content-Type', 'application/json');
    return new Response(JSON.stringify({
        ok: true,
        display_name: profile?.display_name
            ?? (data.user.user_metadata?.display_name as string | undefined)
            ?? data.user.email
            ?? null,
    }), {
        status: 200,
        headers: responseHeaders,
    });
};

