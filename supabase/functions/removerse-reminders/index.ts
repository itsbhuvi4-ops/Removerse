import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = { "Content-Type": "application/json" };
const escapeHtml = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]!));
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return response({ error: "Method not allowed" }, 405);
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (!cronSecret || req.headers.get("x-cron-secret") !== cronSecret) return response({ error: "Unauthorized" }, 401);
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("FROM_EMAIL");
  const adminEmail = Deno.env.get("ADMIN_EMAIL");
  if (!url || !serviceKey || !resendKey || !from || !adminEmail) return response({ error: "Missing server configuration" }, 500);
  const db = createClient(url, serviceKey, { auth: { persistSession: false } });
  const cutoff = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
  const { data: rows, error } = await db.from("registrations")
    .select("id,registration_code,participant_name,college,email,fee_inr,created_at,uploaded_at,team_name,event_id,events(title)")
    .eq("payment_status", "pending_verification").eq("admin_reminder_sent", false)
    .not("uploaded_at", "is", null).lte("uploaded_at", cutoff).limit(200);
  if (error) { console.error("reminder query failed", error.message); return response({ error: "Could not load pending registrations" }, 500); }
  if (!rows?.length) return response({ success: true, reminded: 0 });
  const tableRows = rows.map(r => {
    const event = Array.isArray(r.events) ? r.events[0] : r.events;
    return `<tr><td>${escapeHtml(r.registration_code)}</td><td>${escapeHtml(r.team_name || r.participant_name)}</td><td>${escapeHtml(event?.title || "Event")}</td><td>${escapeHtml(r.college)}</td><td>₹${escapeHtml(r.fee_inr)}</td><td>${escapeHtml(r.uploaded_at)}</td></tr>`;
  }).join("");
  const html = `<h2>REMOVERSE payment proofs awaiting review</h2><p>${rows.length} registration(s) have remained pending for about 20 hours.</p><table border="1" cellpadding="7" cellspacing="0"><thead><tr><th>Code</th><th>Team / participant</th><th>Event</th><th>College</th><th>Fee</th><th>Proof uploaded</th></tr></thead><tbody>${tableRows}</tbody></table><p><a href="${escapeHtml(Deno.env.get("ADMIN_URL") || "https://removerse-2027.vercel.app/admin")}">Open admin dashboard</a></p>`;
  const textBody = rows.map(r => `${r.registration_code} | ${r.team_name || r.participant_name} | ₹${r.fee_inr} | uploaded ${r.uploaded_at}`).join("\n");
  const mail = await fetch("https://api.resend.com/emails", { method:"POST", headers:{ Authorization:`Bearer ${resendKey}`, "Content-Type":"application/json" }, body:JSON.stringify({ from, to:[adminEmail], subject:`REMOVERSE: ${rows.length} payment proof(s) need review`, html, text:textBody }) });
  if (!mail.ok) { console.error("reminder email failed", await mail.text()); return response({ error: "Reminder email failed; registrations remain eligible for retry" }, 502); }
  const ids = rows.map(r => r.id);
  const { error: updateError } = await db.from("registrations").update({ admin_reminder_sent: true }).in("id", ids).eq("payment_status", "pending_verification").eq("admin_reminder_sent", false);
  if (updateError) { console.error("reminder flags failed", updateError.message); return response({ success: true, emailSent: true, flagged: false }); }
  return response({ success: true, reminded: rows.length });
});
