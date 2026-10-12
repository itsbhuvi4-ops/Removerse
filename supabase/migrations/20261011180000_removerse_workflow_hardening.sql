-- Remove a redundant event-management policy introduced by the workflow migration.
-- The pre-existing "admins manage events" policy already enforces private.removerse_is_admin().
drop policy if exists "Admins manage REMOVERSE events" on public.events;

-- Cover existing foreign keys used by audit metadata and avoid avoidable scans.
create index if not exists registrations_reviewed_by_idx
  on public.registrations (reviewed_by) where reviewed_by is not null;
create index if not exists settings_updated_by_idx
  on public.settings (updated_by) where updated_by is not null;
