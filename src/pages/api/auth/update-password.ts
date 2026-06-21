import type {APIRoute} from 'astro';
import {createSupabaseServerClientFromRequest} from '../../../lib/supabase-server';

export const POST: APIRoute = async ({request}) => {
    const responseHeaders = new Headers({'Content-Type': 'application/json'});
    const supabase = createSupabaseServerClientFromRequest(request, responseHeaders);

    const {data: {user}} = await supabase.auth.getUser();
    if (!user) {
        return new Response(JSON.stringify({error: 'Unauthorized.'}), {
            status: 401,
            headers: {'Content-Type': 'application/json'},
        });
    }

    let body: {password?: string};
    try {
        body = await request.json();
    } catch {
        return new Response(JSON.stringify({error: 'Invalid request body.'}), {
            status: 400,
            headers: {'Content-Type': 'application/json'},
        });
    }

    const {password} = body;
    if (!password || password.length < 6) {
        return new Response(JSON.stringify({error: 'Password must be at least 6 characters.'}), {
            status: 400,
            headers: {'Content-Type': 'application/json'},
        });
    }

    const {error} = await supabase.auth.updateUser({password});
    if (error) {
        return new Response(JSON.stringify({error: error.message}), {
            status: 400,
            headers: {'Content-Type': 'application/json'},
        });
    }

    responseHeaders.set('Content-Type', 'application/json');
    return new Response(JSON.stringify({ok: true}), {
        status: 200,
        headers: responseHeaders,
    });
};

