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

## Registration, payment, email and admin workflow (Supabase-only)

The workflow enhancement branch adds the following implementation files. It continues to use the existing Supabase project and does not introduce Convex.

- `supabase/functions/removerse-register/`: server-validated registration; calls an atomic database RPC to enforce duplicate-email and seat limits.
- `supabase/functions/removerse-payment/`: server-timed payment QR countdown, private screenshot upload, student/admin Resend notifications, and rejected-payment retry.
- `supabase/functions/removerse-review/`: verifies the signed-in Supabase user and `profiles.role = 'admin'` on the server before approval/rejection and student email notification.
- `supabase/functions/removerse-status/`: sends a one-time email verification code before returning private registration details.
- `supabase/functions/removerse-reminders/`: sends one combined admin reminder for proofs pending more than about 20 hours.
- `status.html`: Check My Registration, resubmission, and boarding pass QR download.
- `admin/index.html`: /admin/ entry route to the existing secure organiser console.
- `supabase/migrations/20261011170000_removerse_workflow_completion.sql`: additive columns, private QR storage bucket, settings/enquiries/verification-code tables, admin event policy, atomic registration and check-in RPCs.
- `admin.html`: event management, QR/countdown settings, check-in, live registration refresh, protected payment review, and ExcelJS export.

### Required secrets

Set these in Supabase Edge Function secrets (never in browser JavaScript):

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY` (or the server-side publishable-key name used by your project)
- `RESEND_API_KEY`
- `FROM_EMAIL` — a sender address on a verified Resend domain
- `ADMIN_EMAIL`
- `SITE_URL` — e.g. `https://removerse-2027.vercel.app`
- `CRON_SECRET` — a long random value used only by the scheduled reminder caller

### Resend domain setup

1. Add your sending domain in the Resend dashboard.
2. Publish the DNS records Resend provides (SPF/DKIM and any recommended DMARC policy).
3. Wait until Resend marks the domain verified.
4. Set `FROM_EMAIL` to a sender on that verified domain.
5. Send a test to an inbox you control before enabling live registrations.
6. If an email fails, check Edge Function logs and Resend logs. Registration/payment writes must remain successful when mail delivery fails.

### Apply and deploy (preview first)

1. Review this branch and its migration before applying anything to the live project.
2. Apply `supabase/migrations/20261011170000_removerse_workflow_completion.sql` once to the dedicated REMOVERSE project. Do not apply it to BidX/Pixel or any unrelated project.
3. Deploy Edge Functions: `removerse-register`, `removerse-payment`, `removerse-review`, `removerse-status`, and `removerse-reminders`.
4. Set the secrets listed above and verify the QR bucket remains private.
5. Configure a Supabase Cron job to call `POST https://<project-ref>.supabase.co/functions/v1/removerse-reminders` every 15 minutes with the header `x-cron-secret: <CRON_SECRET>`. Store the secret in Supabase Vault or another server-only scheduler secret store; never place it in the frontend or repository.
6. Deploy a preview and run the full checklist below. Do not promote production until verified.

### Workflow test checklist

- [ ] Free registration saves as confirmed and sends a confirmation email.
- [ ] Paid registration saves first and displays the official QR/countdown.
- [ ] QR hides when countdown ends; screenshot upload becomes available.
- [ ] “Ring the bell again” starts a new server timestamp and countdown.
- [ ] Valid JPG/PNG/WebP screenshot up to 5 MB uploads to private storage.
- [ ] Invalid file type, mismatched file signature, and >5 MB file are rejected.
- [ ] Student and admin proof-upload emails are sent; email failure does not undo registration.
- [ ] Admin can approve only after verifying the transaction; student receives an email.
- [ ] Admin rejection requires a reason; student receives an email and can resubmit.
- [ ] Duplicate email for the same event is blocked.
- [ ] Seat limit is enforced by a row-locked atomic registration RPC.
- [ ] One-time status code expires, rejects incorrect attempts, and does not disclose whether an email exists.
- [ ] Pending proof reminder is sent once after ~20 hours; status is rechecked before reminder.
- [ ] Excel export contains clickable private proof links and embedded thumbnails where image format support allows.
- [ ] Check-in accepts only eligible registrations, uses server time, and prevents duplicate arrival.
- [ ] Non-admin account cannot create/edit/delete events or review payments.
- [ ] Mobile layout, keyboard focus, reduced-motion support, and public privacy are checked.

**Deployment note:** The migration and functions are committed on the feature branch; they have not been applied to production by this change. Verify function deployment and live email/payment flows in preview before promotion.
