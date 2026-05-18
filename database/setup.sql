ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own profile"
ON public.profiles
FOR SELECT
USING (auth.uid() = id);

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.profiles (id, role, display_name, created_at)
  VALUES (
    NEW.id,
    'viewer',
    COALESCE(NEW.raw_user_meta_data->>'display_name', NEW.email),
    NOW()
  )
  ON CONFLICT (id) DO UPDATE SET
    display_name = COALESCE(
      EXCLUDED.display_name,
      public.profiles.display_name
    );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();


CREATE TABLE IF NOT EXISTS public.capture_permissions (
    capture_id text NOT NULL,
    user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role       text NOT NULL CHECK (role IN ('owner', 'collaborator')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (capture_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.capture_share_tokens (
    token      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    capture_id text NOT NULL,
    created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz
);

ALTER TABLE public.capture_permissions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capture_share_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read own permissions" ON public.capture_permissions;
CREATE POLICY "read own permissions"
    ON public.capture_permissions FOR SELECT
    USING (user_id = auth.uid());

DROP POLICY IF EXISTS "insert own owner row" ON public.capture_permissions;
CREATE POLICY "insert own owner row"
    ON public.capture_permissions FOR INSERT
    WITH CHECK (user_id = auth.uid() AND role = 'owner');

DROP POLICY IF EXISTS "delete own permission" ON public.capture_permissions;
CREATE POLICY "delete own permission"
    ON public.capture_permissions FOR DELETE
    USING (user_id = auth.uid());

DROP POLICY IF EXISTS "create share token for own capture" ON public.capture_share_tokens;
CREATE POLICY "create share token for own capture"
    ON public.capture_share_tokens FOR INSERT
    WITH CHECK (
        created_by = auth.uid()
        AND EXISTS (
            SELECT 1 FROM public.capture_permissions p
            WHERE p.capture_id = capture_share_tokens.capture_id
              AND p.user_id    = auth.uid()
        )
    );

DROP POLICY IF EXISTS "read own share tokens" ON public.capture_share_tokens;
CREATE POLICY "read own share tokens"
    ON public.capture_share_tokens FOR SELECT
    USING (created_by = auth.uid());

CREATE OR REPLACE FUNCTION public.claim_capture_share(p_token uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_capture_id text;
    v_expires_at timestamptz;
BEGIN
    SELECT capture_id, expires_at
      INTO v_capture_id, v_expires_at
      FROM public.capture_share_tokens
     WHERE token = p_token;

    IF v_capture_id IS NULL THEN
        RAISE EXCEPTION 'Share token not found' USING ERRCODE = 'P0002';
    END IF;

    IF v_expires_at IS NOT NULL AND v_expires_at < now() THEN
        RAISE EXCEPTION 'Share token has expired' USING ERRCODE = 'P0003';
    END IF;

    -- If the user already has any permission for this capture (e.g. owner or prior collaborator),
    -- return NULL gracefully instead of attempting an insert that would fail RLS or conflict.
    IF EXISTS (
        SELECT 1 FROM public.capture_permissions
         WHERE capture_id = v_capture_id AND user_id = auth.uid()
    ) THEN
        RETURN NULL;
    END IF;

    INSERT INTO public.capture_permissions (capture_id, user_id, role)
    VALUES (v_capture_id, auth.uid(), 'collaborator');

    RETURN v_capture_id;
END;
$$;

-- Ensure the function is owned by postgres so that SECURITY DEFINER bypasses RLS on the insert.
ALTER FUNCTION public.claim_capture_share(uuid) OWNER TO postgres;

GRANT EXECUTE ON FUNCTION public.claim_capture_share(uuid) TO authenticated;
