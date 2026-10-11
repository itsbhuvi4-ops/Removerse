-- Browser clients must submit through the validated registration Edge Function.
revoke insert on table public.registrations from public, anon, authenticated;