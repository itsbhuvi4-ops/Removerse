-- Connect REMOVERSE public pages without exposing private registrations.
grant select on public.events to anon, authenticated;
grant select on public.profiles to authenticated;
grant select on public.registrations to authenticated;
grant update on public.registrations to authenticated;
grant delete on public.registrations to authenticated;
grant insert, update, delete on public.events to authenticated;
grant select, update, insert, delete on public.profiles to authenticated;

drop policy if exists "public submits registrations" on public.registrations;

-- Seed current site starter events. Organisers must confirm official names, fees and rules.
insert into public.events
  (slug,title,category,description,subtitle,fee_inr,registration_type,min_team_size,max_team_size,rules,is_active)
values
  ('code-reboot','Code Reboot','Technical','A high-energy technical challenge for curious minds and problem solvers.','Think. Build. Break limits.',100,'team',2,3,'Confirm official event rules with organisers before launch.',true),
  ('pixel-panic','Pixel Panic','Technical','A creative digital design sprint where ideas meet execution.','Design under pressure.',0,'individual',1,1,'Confirm official event rules with organisers before launch.',true),
  ('mind-maze','Mind Maze','Non-Technical','Decode clues, connect the dots and race the clock.','Quick minds win.',50,'team',2,3,'Confirm official event rules with organisers before launch.',true),
  ('spotlight','Spotlight','Non-Technical','Bring your presence, personality and performance to the spotlight.','Own the stage.',0,'individual',1,1,'Confirm official event rules with organisers before launch.',true)
on conflict (slug) do update set
  title=excluded.title, category=excluded.category, description=excluded.description, subtitle=excluded.subtitle,
  fee_inr=excluded.fee_inr, registration_type=excluded.registration_type, min_team_size=excluded.min_team_size,
  max_team_size=excluded.max_team_size, rules=excluded.rules, is_active=true, updated_at=now();