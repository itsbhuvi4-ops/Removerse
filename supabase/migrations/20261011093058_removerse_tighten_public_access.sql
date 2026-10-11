-- Anonymous event reads must not depend on an admin helper.
drop policy if exists "public reads active events" on public.events;
drop policy if exists "anonymous reads active events" on public.events;
create policy "anonymous reads active events" on public.events for select to anon using (is_active);
drop policy if exists "signed in reads active events or admin event details" on public.events
create policy "signed in reads active events or admin event details" on public.events
  for select to authenticated using (is_active or public.removerse_is_admin());

revoke execute on function public.removerse_is_admin() from public, anon;
grant execute on function public.removerse_is_admin() to authenticated, service_role;
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;