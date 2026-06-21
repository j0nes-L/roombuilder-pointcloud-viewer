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

    let body: {display_name?: string};
    try {
        body = await request.json();
    } catch {
        return new Response(JSON.stringify({error: 'Invalid request body.'}), {
            status: 400,
            headers: {'Content-Type': 'application/json'},
        });
    }

    const {display_name} = body;
    if (!display_name || !display_name.trim()) {
        return new Response(JSON.stringify({error: 'Display name cannot be empty.'}), {
            status: 400,
            headers: {'Content-Type': 'application/json'},
        });
    }

    const trimmed = display_name.trim();

    if (trimmed.length < 3 || trimmed.length > 24) {
        return new Response(JSON.stringify({error: 'Display name must be between 3 and 24 characters.'}), {
            status: 400,
            headers: {'Content-Type': 'application/json'},
        });
    }
    if (!/^[\p{L}\p{N} ._-]+$/u.test(trimmed)) {
        return new Response(JSON.stringify({error: 'Display name may only contain letters, numbers, spaces, dots, underscores and hyphens.'}), {
            status: 400,
            headers: {'Content-Type': 'application/json'},
        });
    }

    const {error: profileError} = await supabase
        .from('profiles')
        .update({display_name: trimmed})
        .eq('id', user.id);

    if (profileError) {
        if (profileError.code === '23505') {
            return new Response(JSON.stringify({error: 'This display name is already taken. Please choose another.'}), {
                status: 409,
                headers: {'Content-Type': 'application/json'},
            });
        }
        return new Response(JSON.stringify({error: profileError.message}), {
            status: 400,
            headers: {'Content-Type': 'application/json'},
        });
    }

    await supabase.auth.updateUser({data: {display_name: trimmed}});

    responseHeaders.set('Content-Type', 'application/json');
    return new Response(JSON.stringify({ok: true, display_name: trimmed}), {
        status: 200,
        headers: responseHeaders,
    });
};
