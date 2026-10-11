-- Additive migration for the existing REMOVERSE Supabase schema.
-- Existing registrations/events are preserved; this migration does not drop or rewrite records.

alter table public.events
  add column if not exists event_date date,
  add column if not exists venue text,
  add column if not exists coordinator text,
  add column if not exists seats integer check (seats is null or seats >= 0),
  add column if not exists is_featured boolean not null default false;
alter table public.registrations
  add column if not exists members jsonb not null default '[]'::jsonb;

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

-- Serialize capacity checks and duplicate detection with the insert itself.
-- Only the trusted Edge Function service role may execute this privileged function.
create or replace function public.create_removerse_registration(
  p_event_id uuid,
  p_name text,
  p_college text,
  p_department text,
  p_study_year text,
  p_phone text,
  p_email text,
  p_team text,
  p_members jsonb,
  p_rules_accepted boolean
)
returns table (
  registration_id uuid,
  registration_code text,
  fee_inr numeric,
  payment_status text,
  registration_status text,
  event_title text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  ev public.events%rowtype;
  active_count integer;
  existing_code text;
  new_row public.registrations%rowtype;
begin
  select * into ev from public.events
    where id = p_event_id and is_active = true
    for update;
  if not found then raise exception 'EVENT_UNAVAILABLE'; end if;
  if p_rules_accepted is not true then raise exception 'RULES_REQUIRED'; end if;
  if length(trim(p_name)) < 2 or length(trim(p_college)) < 2 or length(trim(p_department)) < 2
     or length(trim(p_phone)) < 8 or p_email !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  then raise exception 'INVALID_DETAILS'; end if;
  if ev.registration_type = 'team' and length(trim(coalesce(p_team,''))) < 2 then
    raise exception 'TEAM_REQUIRED';
  end if;
  if ev.registration_type = 'team' and (
    jsonb_typeof(coalesce(p_members,'[]'::jsonb)) <> 'array'
    or jsonb_array_length(coalesce(p_members,'[]'::jsonb)) < coalesce(ev.min_team_size,2)
    or jsonb_array_length(coalesce(p_members,'[]'::jsonb)) > coalesce(ev.max_team_size,10)
  ) then raise exception 'TEAM_SIZE_INVALID'; end if;
  if ev.registration_type = 'individual' and length(trim(coalesce(p_team,''))) > 0 then
    raise exception 'TEAM_NOT_ALLOWED';
  end if;
  select registration_code into existing_code from public.registrations
    where event_id = p_event_id and lower(email) = lower(trim(p_email))
    order by created_at desc limit 1;
  if found then raise exception 'DUPLICATE_EVENT_EMAIL:%', existing_code; end if;
  if ev.seats is not null then
    select count(*) into active_count from public.registrations
      where event_id = p_event_id and registration_status <> 'rejected';
    if active_count >= ev.seats then raise exception 'EVENT_FULL'; end if;
  end if;
  insert into public.registrations(
    event_id, participant_name, college, department, study_year, phone, email,
    team_name, members, utr, payment_proof_path, fee_inr, payment_status, registration_status, rules_accepted
  ) values (
    ev.id, trim(p_name), trim(p_college), trim(p_department), trim(p_study_year), trim(p_phone), lower(trim(p_email)),
    nullif(trim(coalesce(p_team,'')),''), coalesce(p_members,'[]'::jsonb), null, null, ev.fee_inr,
    case when ev.fee_inr > 0 then 'pending_verification' else 'not_required' end,
    case when ev.fee_inr > 0 then 'pending' else 'confirmed' end,
    true
  ) returning * into new_row;
  return query select new_row.id, new_row.registration_code, new_row.fee_inr,
    new_row.payment_status, new_row.registration_status, ev.title;
end;
$$;
revoke all on function public.create_removerse_registration(uuid,text,text,text,text,text,text,text,jsonb,boolean) from public, anon, authenticated;
grant execute on function public.create_removerse_registration(uuid,text,text,text,text,text,text,text,jsonb,boolean) to service_role;

-- Preserve the existing lifecycle while allowing the check-in state.
-- The original constraint only permitted pending, confirmed, and rejected.
alter table public.registrations
  drop constraint if exists registrations_registration_status_check;
alter table public.registrations
  add constraint registrations_registration_status_check
  check (registration_status = any (array['pending','confirmed','rejected','arrived']::text[]));

-- Authenticated organisers can manage event records only when their profile role is admin.
drop policy if exists "Admins manage REMOVERSE events" on public.events;
create policy "Admins manage REMOVERSE events" on public.events for all to authenticated
  using (exists (select 1 from public.profiles p where p.user_id = (select auth.uid()) and p.role = 'admin'))
  with check (exists (select 1 from public.profiles p where p.user_id = (select auth.uid()) and p.role = 'admin'));

create or replace function public.mark_removerse_arrived(p_registration_id uuid)
returns table(registration_id uuid, registration_code text, arrived_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare r public.registrations%rowtype;
begin
  if not exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role = 'admin') then
    raise exception 'ADMIN_REQUIRED';
  end if;
  select * into r from public.registrations where id = p_registration_id for update;
  if not found then raise exception 'REGISTRATION_NOT_FOUND'; end if;
  if r.registration_status = 'arrived' then raise exception 'ALREADY_ARRIVED'; end if;
  if r.payment_status not in ('approved','not_required') and r.registration_status <> 'confirmed' then
    raise exception 'REGISTRATION_NOT_ELIGIBLE';
  end if;
  update public.registrations set registration_status = 'arrived', arrived_at = now()
    where id = p_registration_id returning * into r;
  return query select r.id, r.registration_code, r.arrived_at;
end;
$$;
revoke all on function public.mark_removerse_arrived(uuid) from public, anon;
grant execute on function public.mark_removerse_arrived(uuid) to authenticated;

-- Public event catalogue exposes only event metadata and an aggregate availability count.
create or replace function public.list_removerse_public_events()
returns table(
  id uuid, slug text, title text, category text, description text, subtitle text,
  fee_inr numeric, registration_type text, min_team_size integer, max_team_size integer,
  rules text, event_date date, venue text, coordinator text, seats integer,
  seats_left integer, is_featured boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select e.id,e.slug,e.title,e.category,e.description,e.subtitle,e.fee_inr,e.registration_type,
    e.min_team_size,e.max_team_size,e.rules,e.event_date,e.venue,e.coordinator,e.seats,
    case when e.seats is null then null else greatest(0,e.seats - (
      select count(*)::integer from public.registrations r
      where r.event_id=e.id and r.registration_status <> 'rejected'
    )) end as seats_left,
    e.is_featured
  from public.events e where e.is_active=true order by e.is_featured desc,e.created_at asc;
$$;
revoke all on function public.list_removerse_public_events() from public;
grant execute on function public.list_removerse_public_events() to anon, authenticated;
