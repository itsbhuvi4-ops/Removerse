-- Additive migration for the existing REMOVERSE Supabase schema.
-- Existing registrations/events are preserved; this migration does not drop or rewrite records.

alter table public.registrations
  add column if not exists payment_started_at timestamptz,
  add column if not exists uploaded_at timestamptz,
  add column if not exists admin_reminder_sent boolean not null default false,
  add column if not exists arrived_at timestamptz;

create index if not exists registrations_pending_reminder_idx
  on public.registrations (created_at)
  where payment_status = 'pending_verification' and admin_reminder_sent = false;

create index if not exists registrations_event_status_idx
  on public.registrations (event_id, registration_status, payment_status);

create table if not exists public.settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
alter table public.settings enable row level security;
revoke all on public.settings from anon, authenticated;
grant select, insert, update, delete on public.settings to authenticated;
drop policy if exists "Admins manage REMOVERSE settings" on public.settings;
create policy "Admins manage REMOVERSE settings"
  on public.settings for all to authenticated
  using (exists (select 1 from public.profiles p where p.user_id = (select auth.uid()) and p.role = 'admin'))
  with check (exists (select 1 from public.profiles p where p.user_id = (select auth.uid()) and p.role = 'admin'));

insert into public.settings(key, value)
values ('payment_countdown_seconds', '30'::jsonb)
on conflict (key) do nothing;

create table if not exists public.enquiries (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  email text not null check (length(email) <= 254),
  message text not null check (length(trim(message)) between 1 and 4000),
  created_at timestamptz not null default now()
);
alter table public.enquiries enable row level security;
revoke all on public.enquiries from anon, authenticated;
grant select, update, delete on public.enquiries to authenticated;
drop policy if exists "Admins read enquiries" on public.enquiries;
create policy "Admins read enquiries" on public.enquiries for select to authenticated
  using (exists (select 1 from public.profiles p where p.user_id = (select auth.uid()) and p.role = 'admin'));
drop policy if exists "Admins update enquiries" on public.enquiries;
create policy "Admins update enquiries" on public.enquiries for update to authenticated
  using (exists (select 1 from public.profiles p where p.user_id = (select auth.uid()) and p.role = 'admin'))
  with check (exists (select 1 from public.profiles p where p.user_id = (select auth.uid()) and p.role = 'admin'));

create table if not exists public.registration_access_codes (
  id uuid primary key default gen_random_uuid(),
  lookup_hash text not null,
  delivery_email text not null,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts integer not null default 0 check (attempts between 0 and 6),
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists registration_access_codes_lookup_idx
  on public.registration_access_codes(lookup_hash, created_at desc);
alter table public.registration_access_codes enable row level security;
revoke all on public.registration_access_codes from anon, authenticated;

-- Storage remains private. Admin proof access must use short-lived signed URLs.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('removerse-payment-qr', 'removerse-payment-qr', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = false, file_size_limit = 5242880, allowed_mime_types = array['image/jpeg','image/png','image/webp'];

drop policy if exists "Admins manage payment QR" on storage.objects;
create policy "Admins manage payment QR" on storage.objects for all to authenticated
  using (bucket_id = 'removerse-payment-qr' and exists (select 1 from public.profiles p where p.user_id = (select auth.uid()) and p.role = 'admin'))
  with check (bucket_id = 'removerse-payment-qr' and exists (select 1 from public.profiles p where p.user_id = (select auth.uid()) and p.role = 'admin'));

-- Reminder and status lookups use service-role Edge Functions; no public table policies are granted.
