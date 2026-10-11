-- Ensure the registration RPC returns the declared numeric fee type.
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
  select r.registration_code into existing_code
    from public.registrations as r
    where r.event_id = p_event_id and lower(r.email) = lower(trim(p_email))
    order by r.created_at desc limit 1;
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
  return query select new_row.id, new_row.registration_code, new_row.fee_inr::numeric,
    new_row.payment_status, new_row.registration_status, ev.title;
end;
$$;
revoke all on function public.create_removerse_registration(uuid,text,text,text,text,text,text,text,jsonb,boolean) from public, anon, authenticated;
grant execute on function public.create_removerse_registration(uuid,text,text,text,text,text,text,text,jsonb,boolean) to service_role;
