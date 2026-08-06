DO $$
DECLARE
  v_instance_id uuid := '00000000-0000-0000-0000-000000000000';
  v_default_password text := 'Zirconix@123';
  v_password_hash text;
  v_user record;
  v_entity_id uuid;
  v_user_id uuid;
BEGIN
  -- 0. Clean up any broken users that don't have identities from previous run
  DELETE FROM auth.users 
  WHERE email IN (
    'mineszircon@gmail.com', 
    'daniyalalidkh121@gmail.com', 
    'moaizalishah@gmail.com', 
    'ravian0479@gmail.com', 
    'Zubairqasimi300@gmail.com', 
    'Zaynm6337@gmail.com'
  ) AND NOT EXISTS (
    SELECT 1 FROM auth.identities WHERE auth.identities.user_id = auth.users.id
  );

  -- 1. Pre-hash the password to be used for all the new users
  v_password_hash := crypt(v_default_password, gen_salt('bf'));

  -- 2. Insert into public.directors first
  -- The trigger 'on_auth_user_created_link_director' expects the director to exist
  INSERT INTO public.directors (full_name, email, role) VALUES
    ('Mines Zircon', 'mineszircon@gmail.com', 'director'),
    ('Daniyal Ali', 'daniyalalidkh121@gmail.com', 'director'),
    ('Moaiz Ali Shah', 'moaizalishah@gmail.com', 'director'),
    ('Ravian', 'ravian0479@gmail.com', 'director'),
    ('Zubair Qasimi', 'Zubairqasimi300@gmail.com', 'director'),
    ('Zayn M', 'Zaynm6337@gmail.com', 'director')
  ON CONFLICT (email) DO NOTHING;

  -- 3. Insert into auth.users and auth.identities
  FOR v_user IN (
    SELECT email FROM public.directors 
    WHERE email IN (
      'mineszircon@gmail.com', 
      'daniyalalidkh121@gmail.com', 
      'moaizalishah@gmail.com', 
      'ravian0479@gmail.com', 
      'Zubairqasimi300@gmail.com', 
      'Zaynm6337@gmail.com'
    )
  )
  LOOP
    IF NOT EXISTS (SELECT 1 FROM auth.users WHERE email = v_user.email) THEN
      v_user_id := gen_random_uuid();
      
      -- Insert the auth.users record
      INSERT INTO auth.users (
        instance_id, id, aud, role, email, encrypted_password, 
        email_confirmed_at, raw_app_meta_data, raw_user_meta_data, 
        created_at, updated_at,
        confirmation_token, email_change, email_change_token_new, recovery_token
      )
      VALUES (
        v_instance_id, v_user_id, 'authenticated', 'authenticated', v_user.email, v_password_hash,
        now(), '{"provider":"email","providers":["email"]}', '{}',
        now(), now(),
        '', '', '', ''
      );

      -- Supabase requires an identity record for the email provider, otherwise login returns HTTP 500
      INSERT INTO auth.identities (
        id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
      )
      VALUES (
        gen_random_uuid(), v_user_id, v_user_id::text, 
        format('{"sub":"%s","email":"%s","email_verified":false,"phone_verified":false}', v_user_id, v_user.email)::jsonb, 
        'email', now(), now(), now()
      );
    END IF;
  END LOOP;
  
  -- 4. (Optional) Assign them to existing entities so they can see data
  FOR v_entity_id IN (SELECT id FROM public.entities) LOOP
    INSERT INTO public.director_entities (director_id, entity_id)
    SELECT d.id, v_entity_id
    FROM public.directors d
    WHERE d.email IN (
      'mineszircon@gmail.com', 
      'daniyalalidkh121@gmail.com', 
      'moaizalishah@gmail.com', 
      'ravian0479@gmail.com', 
      'Zubairqasimi300@gmail.com', 
      'Zaynm6337@gmail.com'
    )
    ON CONFLICT DO NOTHING;
  END LOOP;

END $$;
