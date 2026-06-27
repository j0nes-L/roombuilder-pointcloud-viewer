import type {APIRoute} from 'astro';
import type {EmailOtpType} from '@supabase/supabase-js';
import {createSupabaseServerClientFromRequest} from '../../../lib/supabase-server';

export const POST: APIRoute = async ({request}) => {
    const buildRedirect = (location: string, extraHeaders?: Headers) => {
        const headers = new Headers(extraHeaders);
        headers.set('Location', location);
        return new Response(null, {status: 303, headers});
    };

    let tokenHash = '';
    let type: EmailOtpType = 'signup';
    let flow = 'signup';
    try {
        const form = await request.formData();
        tokenHash = String(form.get('token_hash') ?? '');
        type = (String(form.get('type') ?? 'signup') || 'signup') as EmailOtpType;
        flow = String(form.get('flow') ?? '') || (type === 'recovery' ? 'recovery' : 'signup');
    } catch {
        return buildRedirect(
            `/account?toast=error&msg=${encodeURIComponent('Invalid or missing confirmation link.')}`
        );
    }

    if (!tokenHash) {
        return buildRedirect(
            `/account?toast=error&msg=${encodeURIComponent('Invalid or missing confirmation link.')}`
        );
    }

    const responseHeaders = new Headers();
    const supabase = createSupabaseServerClientFromRequest(request, responseHeaders);

    const {error} = await supabase.auth.verifyOtp({type, token_hash: tokenHash});

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

