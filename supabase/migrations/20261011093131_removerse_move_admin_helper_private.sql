create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated, service_role;

create or replace function private.removerse_is_admin()
returns boolean language sql stable security definer
set search_path = public, auth
as $$
  select exists(select 1 from public.profiles p where p.user_id = auth.uid() and p.role = 'admin');
$$;
revoke all on function private.removerse_is_admin() from public, anon, authenticated;
grant execute on function private.removerse_is_admin() to authenticated, service_role;

drop policy if exists "profile owner or admin reads profile" on public.profiles;
create policy "profile owner or admin reads profile" on public.profiles
  for select to authenticated using (user_id = auth.uid() or private.removerse_is_admin());
drop policy if exists "admins manage profiles" on public.profiles;
create policy "admins manage profiles" on public.profiles
  for all to authenticated using (private.removerse_is_admin()) with check (private.removerse_is_admin());

drop policy if exists "admins manage events" on public.events;
create policy "admins manage events" on public.events
  for all to authenticated using (private.removerse_is_admin()) with check (private.removerse_is_admin());
drop policy if exists "signed in reads active events or admin event details" on public.events;
create policy "signed in reads active events or admin event details" on public.events
  for select to authenticated using (is_active or private.removerse_is_admin());

drop policy if exists "admins read registrations" on public.registrations;
create policy "admins read registrations" on public.registrations for select to authenticated using (private.removerse_is_admin());
drop policy if exists "admins update registrations" on public.registrations;
create policy "admins update registrations" on public.registrations
  for update to authenticated using (private.removerse_is_admin()) with check (private.removerse_is_admin());
drop policy if exists "admins delete registrations" on public.registrations;
create policy "admins delete registrations" on public.registrations for delete to authenticated using (private.removerse_is_admin());

drop policy if exists "admins read payment proofs" on storage.objects;
create policy "admins read payment proofs" on storage.objects
  for select to authenticated using (bucket_id = 'removerse-payment-proofs' and private.removerse_is_admin());
drop policy if exists "admins manage payment proofs" on storage.objects;
create policy "admins manage payment proofs" on storage.objects
  for all to authenticated using (bucket_id = 'removerse-payment-proofs' and private.removerse_is_admin())
  with check (bucket_id = 'removerse-payment-proofs' and private.removerse_is_admin());

drop function if exists public.removerse_is_admin();