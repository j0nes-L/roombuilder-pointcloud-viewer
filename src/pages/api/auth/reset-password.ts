import type {APIRoute} from 'astro';
import {createSupabaseServerClientFromRequest} from '../../../lib/supabase-server';
import {getOrigin} from '../../../lib/get-origin';

export const POST: APIRoute = async ({request}) => {
    const responseHeaders = new Headers({'Content-Type': 'application/json'});
    const supabase = createSupabaseServerClientFromRequest(request, responseHeaders);

    let body: {email?: string};
    try {
        body = await request.json();
    } catch {
        return new Response(JSON.stringify({error: 'Invalid request body.'}), {
            status: 400,
            headers: {'Content-Type': 'application/json'},
        });
    }

    const {email} = body;
    if (!email) {
        return new Response(JSON.stringify({error: 'Email required.'}), {
            status: 400,
            headers: {'Content-Type': 'application/json'},
        });
    }

    const {error} = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${getOrigin(request)}/api/auth/callback?flow=recovery`,
    });

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

