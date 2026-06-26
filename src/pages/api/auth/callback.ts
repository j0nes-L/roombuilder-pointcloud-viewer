import type {APIRoute} from 'astro';
import type {EmailOtpType} from '@supabase/supabase-js';
import {createSupabaseServerClientFromRequest} from '../../../lib/supabase-server';

export const GET: APIRoute = async ({request}) => {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const tokenHash = url.searchParams.get('token_hash');
    const type = url.searchParams.get('type') as EmailOtpType | null;
    const flow = url.searchParams.get('flow')
        ?? (type === 'recovery' ? 'recovery' : 'signup');

    const buildRedirect = (location: string, extraHeaders?: Headers) => {
        const headers = new Headers(extraHeaders);
        headers.set('Location', location);
        return new Response(null, {status: 302, headers});
    };

    if (!code && !(tokenHash && type)) {
        return buildRedirect(
            `/account?toast=error&msg=${encodeURIComponent('Invalid or missing confirmation link.')}`
        );
    }

    const responseHeaders = new Headers();
    const supabase = createSupabaseServerClientFromRequest(request, responseHeaders);

    const {error} = tokenHash && type
        ? await supabase.auth.verifyOtp({type, token_hash: tokenHash})
        : await supabase.auth.exchangeCodeForSession(code as string);

    if (error) {
        const isExpired = /expired|invalid/i.test(error.message);
        const msg = isExpired
            ? 'This link has expired or is invalid. Please request a new one.'
            : error.message;
        return buildRedirect(
            `/account?toast=error&msg=${encodeURIComponent(msg)}`
        );
    }

    if (flow === 'recovery') {
        return buildRedirect(
            `/account?mode=update-password&toast=info&msg=${encodeURIComponent('Please set your new password below.')}`,
            responseHeaders
        );
    }

    await supabase.auth.signOut({scope: 'local'});

    return buildRedirect(
        `/account?toast=success&msg=${encodeURIComponent('Email confirmed! You can now log in.')}`
    );
};
