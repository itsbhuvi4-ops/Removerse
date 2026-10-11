-- REMOVERSE 2027 initial production schema.
-- Apply only to a dedicated REMOVERSE Supabase project, never an unrelated project.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  role text not null default 'organiser' check (role in ('admin','organiser')),
  created_at timestamptz not null default now()
);

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  category text not null check (category in ('Technical','Non-Technical')),
  description text not null default '',
  subtitle text not null default '',
  fee_inr integer not null default 0 check (fee_inr >= 0),
  registration_type text not null default 'individual' check (registration_type in ('individual','team')),
  min_team_size integer not null default 1 check (min_team_size >= 1),
  max_team_size integer not null default 1 check (max_team_size >= min_team_size),
  rules text not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.registrations (
  id uuid primary key default gen_random_uuid(),
  registration_code text not null unique default ('RMV-' || upper(substr(encode(gen_random_bytes(8),'hex'),1,10))),
  event_id uuid not null references public.events(id) on delete restrict,
  participant_name text not null check (length(trim(participant_name)) between 2 and 100),
  college text not null check (length(trim(college)) between 2 and 160),
  department text not null check (length(trim(department)) between 2 and 100),
  study_year text not null check (length(trim(study_year)) between 1 and 30),
  phone text not null check (length(trim(phone)) between 8 and 24),
  email text not null check (length(trim(email)) between 5 and 254),
  team_name text,
  utr text,
  payment_proof_path text,
  fee_inr integer not null default 0 check (fee_inr >= 0),
  payment_status text not null default 'not_required' check (payment_status in ('not_required','pending_verification','approved','rejected')),
  registration_status text not null default 'confirmed' check (registration_status in ('pending','confirmed','rejected')),
  rules_accepted boolean not null default false check (rules_accepted),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now()
);

create index if not exists registrations_created_at_idx on public.registrations(created_at desc);
create index if not exists registrations_event_idx on public.registrations(event_id);
create index if not exists registrations_status_idx on public.registrations(registration_status, payment_status);
create index if not exists registrations_email_idx on public.registrations(lower(email));

create or replace function public.removerse_is_admin()
returns boolean language sql stable security definer
set search_path = public, auth
as $$
  select exists(select 1 from public.profiles p where p.user_id = auth.uid() and p.role = 'admin');
$$;
revoke all on function public.removerse_is_admin() from public;
grant execute on function public.removerse_is_admin() to authenticated;

alter table public.profiles enable row level security;
alter table public.events enable row level security;
alter table public.registrations enable row level security;

drop policy if exists "profile owner or admin reads profile" on public.profiles;
create policy "profile owner or admin reads profile" on public.profiles
  for select to authenticated using (user_id = auth.uid() or public.removerse_is_admin());
drop policy if exists "admins manage profiles" on public.profiles;
create policy "admins manage profiles" on public.profiles
  for all to authenticated using (public.removerse_is_admin()) with check (public.removerse_is_admin());

drop policy if exists "public reads active events" on public.events;
create policy "public reads active events" on public.events
  for select to anon, authenticated using (is_active or public.removerse_is_admin());
drop policy if exists "admins manage events" on public.events;
create policy "admins manage events" on public.events
  for all to authenticated using (public.removerse_is_admin()) with check (public.removerse_is_admin());

drop policy if exists "public submits registrations" on public.registrations;
create policy "public submits registrations" on public.registrations
  for insert to anon, authenticated with check (
    rules_accepted = true
    and payment_status = case when fee_inr = 0 then 'not_required' else 'pending_verification' end
    and registration_status = case when fee_inr = 0 then 'confirmed' else 'pending' end
    and reviewed_by is null and reviewed_at is null
    and exists(select 1 from public.events e where e.id = event_id and e.is_active and e.fee_inr = registrations.fee_inr)
  );
drop policy if exists "admins read registrations" on public.registrations;
create policy "admins read registrations" on public.registrations
  for select to authenticated using (public.removerse_is_admin());
drop policy if exists "admins update registrations" on public.registrations;
create policy "admins update registrations" on public.registrations
  for update to authenticated using (public.removerse_is_admin()) with check (public.removerse_is_admin());
drop policy if exists "admins delete registrations" on public.registrations;
create policy "admins delete registrations" on public.registrations
  for delete to authenticated using (public.removerse_is_admin());

-- Private payment proof bucket. Do not make this bucket public.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('removerse-payment-proofs','removerse-payment-proofs',false,5242880,array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do update set public=false, file_size_limit=5242880, allowed_mime_types=array['image/jpeg','image/png','image/webp','application/pdf'];

drop policy if exists "admins read payment proofs" on storage.objects;
create policy "admins read payment proofs" on storage.objects for select to authenticated
  using (bucket_id = 'removerse-payment-proofs' and public.removerse_is_admin());
drop policy if exists "admins manage payment proofs" on storage.objects;
create policy "admins manage payment proofs" on storage.objects for all to authenticated
  using (bucket_id = 'removerse-payment-proofs' and public.removerse_is_admin())
  with check (bucket_id = 'removerse-payment-proofs' and public.removerse_is_admin());

-- IMPORTANT: After creating the first organiser account in Supabase Auth,
-- explicitly grant admin in the SQL editor:
-- insert into public.profiles(user_id, display_name, role)
-- select id, 'REMOVERSE Admin', 'admin' from auth.users where email = 'YOUR_ADMIN_EMAIL'
-- on conflict (user_id) do update set role='admin';
-- Do not enable public signup for organiser/admin roles.
