import type {APIRoute} from 'astro';
import {createSupabaseServerClientFromRequest} from '../../../lib/supabase-server';
import {getOrigin} from '../../../lib/get-origin';

export const POST: APIRoute = async ({request}) => {
    const responseHeaders = new Headers({'Content-Type': 'application/json'});
    const supabase = createSupabaseServerClientFromRequest(request, responseHeaders);

    let body: {email?: string; password?: string; display_name?: string};
    try {
        body = await request.json();
    } catch {
        return new Response(JSON.stringify({error: 'Invalid request body.'}), {
            status: 400,
            headers: {'Content-Type': 'application/json'},
        });
    }

    const {email, password, display_name} = body;
    if (!email || !password || !display_name) {
        return new Response(JSON.stringify({error: 'Email, password and display name required.'}), {
            status: 400,
            headers: {'Content-Type': 'application/json'},
        });
    }

    const trimmedName = display_name.trim();
    if (trimmedName.length < 3 || trimmedName.length > 24) {
        return new Response(JSON.stringify({error: 'Display name must be between 3 and 24 characters.'}), {
            status: 400,
            headers: {'Content-Type': 'application/json'},
        });
    }
    if (!/^[\p{L}\p{N} ._-]+$/u.test(trimmedName)) {
        return new Response(JSON.stringify({error: 'Display name may only contain letters, numbers, spaces, dots, underscores and hyphens.'}), {
            status: 400,
            headers: {'Content-Type': 'application/json'},
        });
    }

    const {data, error} = await supabase.auth.signUp({
        email,
        password,
        options: {
            data: {display_name: trimmedName},
            emailRedirectTo: `${getOrigin(request)}/api/auth/callback?flow=signup`,
        },
    });

    if (error) {
        let msg = error.message;
        if (/user already registered/i.test(msg))
            msg = 'This email address is already registered. Please log in instead.';
        else if (/email.*rate.limit|too many/i.test(msg))
            msg = 'Too many attempts. Please wait a moment and try again.';
        else if (/invalid email/i.test(msg))
            msg = 'Please enter a valid email address.';
        else if (/password.*short|at least/i.test(msg))
            msg = 'Password must be at least 6 characters.';
        return new Response(JSON.stringify({error: msg}), {
            status: 400,
            headers: {'Content-Type': 'application/json'},
        });
    }

    const needsConfirmation = !data.session;

    responseHeaders.set('Content-Type', 'application/json');
    return new Response(JSON.stringify({ok: true, needsConfirmation, display_name: trimmedName}), {
        status: 200,
        headers: responseHeaders,
    });
};

