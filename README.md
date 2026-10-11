# REMOVERSE 2027

Public fest website for the BCA programme, School of Information Technology, Guru Nanak College (Autonomous), Chennai.

## Architecture

- Static HTML/CSS/JavaScript frontend hosted on Vercel.
- Supabase project: `Removerse` (`irxifzwvtmjdvignqgap`).
- Public event catalogue reads active rows from `public.events`.
- Registration submissions go through the `removerse-register` Supabase Edge Function. The browser cannot insert directly into `public.registrations`.
- Paid registration proof files are uploaded by the Edge Function into the private `removerse-payment-proofs` bucket (5 MB maximum; JPG, PNG, WebP or PDF). Payment remains pending until an organiser independently checks the bank/UPI transaction.
- Organiser dashboard: `/admin`. It uses Supabase Auth and requires an explicit `admin` role in `public.profiles`. RLS protects registration and proof access.
- Only the Supabase publishable key is present in `supabase-config.js`. Never commit a service-role key.

## First admin setup (required)

There are currently no Auth users or admin profiles in this new project, so the admin dashboard cannot be used until the owner creates the first admin account.

1. Open the [REMOVERSE Supabase project](https://supabase.com/dashboard/project/irxifzwvtmjdvignqgap).
2. In **Authentication → Users**, create a user with the organiser's own email and a strong password. Do not enable public organiser sign-up.
3. In the SQL Editor, replace `YOUR_ADMIN_EMAIL` with that exact email and run:

```sql
insert into public.profiles (user_id, display_name, role)
select id, 'REMOVERSE Admin', 'admin'
from auth.users
where lower(email) = lower('YOUR_ADMIN_EMAIL')
on conflict (user_id)
do update set display_name = excluded.display_name, role = 'admin';
```

4. Open `/admin` and sign in with that account.

The admin dashboard validates the profile role after login; a normal Auth account is not automatically an administrator.

## Event data

The four currently seeded events (Code Reboot, Pixel Panic, Mind Maze and Spotlight) are starter examples carried over from the prototype. Confirm the official event names, fees, rules, team limits, dates and payment QR before opening registrations to the public.

## Database migrations

The files in `supabase/migrations/` mirror the applied database migrations. Apply future changes only to the dedicated REMOVERSE project, not the Pixel/BidX or other Supabase projects.

## Pre-launch checklist

- [ ] Create the first admin account and grant the role.
- [ ] Confirm event names, entry fees, rules, date, venue and team sizes.
- [ ] Add the official payment instructions/QR and independently test a small payment.
- [ ] Test free registration end-to-end.
- [ ] Test paid registration with a non-production sample payment and verify private proof access.
- [ ] Verify approve/reject permissions with an admin and a non-admin account.
- [ ] Confirm the intended Vercel deployment protection policy before sharing the site publicly.
