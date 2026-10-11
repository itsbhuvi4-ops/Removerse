import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function text(form: FormData, key: string, max: number) {
  const value = String(form.get(key) ?? "").trim();
  if (value.length > max) throw new Error(`${key} is too long`);
  return value;
}
function validEmail(value: string) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
function signatureMatches(type: string, bytes: Uint8Array) {
  if (type === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === "image/png") return bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v);
  if (type === "image/webp") return bytes.length >= 12 && String.fromCharCode(...bytes.slice(0,4)) === "RIFF" && String.fromCharCode(...bytes.slice(8,12)) === "WEBP";
  if (type === "application/pdf") return bytes.length >= 5 && String.fromCharCode(...bytes.slice(0,5)) === "%PDF-";
  return false;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return respond({ error: "Method not allowed" }, 405);
  let uploadedPath: string | null = null;
  let storageClient: any = null;
  try {
    const contentLength = Number(req.headers.get("content-length") || 0);
    if (contentLength > 6 * 1024 * 1024) return respond({ error: "Request is too large. Maximum upload is 5 MB." }, 413);
    const form = await req.formData();
    if (text(form, "website", 200)) return respond({ error: "Unable to process this request." }, 400);
    const eventId = text(form, "event_id", 64);
    const name = text(form, "name", 100);
    const college = text(form, "college", 160);
    const department = text(form, "department", 100);
    const year = text(form, "year", 30);
    const phone = text(form, "phone", 24);
    const email = text(form, "email", 254).toLowerCase();
    const team = text(form, "team", 100);
    const membersRaw = text(form, "members", 2000);
    const members = eventMembers(membersRaw);
    const utr = text(form, "utr", 80);
    const rulesAccepted = form.get("rules") === "true";
    if (!/^[0-9a-f-]{36}$/i.test(eventId)) return respond({ error: "Invalid event selection." }, 400);
    if (name.length < 2 || college.length < 2 || department.length < 2 || !year || phone.length < 8 || !validEmail(email)) return respond({ error: "Please check all required participant details." }, 400);
    if (!rulesAccepted) return respond({ error: "You must accept the event rules." }, 400);
    const url = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !serviceKey) return respond({ error: "Registration service is not configured." }, 500);
    const supabase = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    storageClient = supabase;
    const { count: adminCount, error: adminCheckError } = await supabase
      .from("profiles").select("user_id", { count: "exact", head: true }).eq("role", "admin");
    if (adminCheckError) return respond({ error: "Registration service is temporarily unavailable. Please try again." }, 503);
    if ((adminCount ?? 0) < 1) {
      return respond({ error: "Registration is temporarily closed while organiser access is being configured. Please try again later." }, 503);
    }
    const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const [emailRecent, phoneRecent] = await Promise.all([
      supabase.from("registrations").select("id", { count: "exact", head: true }).eq("email", email).gte("created_at", cutoff),
      supabase.from("registrations").select("id", { count: "exact", head: true }).eq("phone", phone).gte("created_at", cutoff),
    ]);
    if (emailRecent.error || phoneRecent.error) return respond({ error: "Registration service is temporarily unavailable. Please try again." }, 503);
    if ((emailRecent.count ?? 0) >= 3 || (phoneRecent.count ?? 0) >= 3) return respond({ error: "Too many recent attempts for these contact details. Please wait a few minutes or contact the organisers." }, 429);
    const { data: event, error: eventError } = await supabase.from("events")
      .select("id,title,fee_inr,registration_type,min_team_size,max_team_size,is_active").eq("id", eventId).maybeSingle();
    if (eventError || !event || !event.is_active) return respond({ error: "This event is unavailable. Refresh the page and try again." }, 400);
    if (event.registration_type === "team" && team.length < 2) return respond({ error: "Please enter your team name." }, 400);
    if (event.registration_type === "team" && (members.length < Number(event.min_team_size || 2) || members.length > Number(event.max_team_size || 10))) return respond({ error: "Enter between "+event.min_team_size+" and "+event.max_team_size+" team members, one per line." }, 400);
    if (members.some(v=>v.length>100)) return respond({ error: "Each team member name must be 100 characters or fewer." }, 400);
    if (event.registration_type === "individual" && team) return respond({ error: "Team name is not accepted for this event." }, 400);
    const paid = Number(event.fee_inr) > 0;
    // Paid registrations are created before the payment countdown and proof upload.
    // The separate removerse-payment Edge Function records server time and accepts the proof.
    const proof = form.get("proof");
    if (paid && proof instanceof File && proof.size > 0) {
      return respond({ error: "Please submit the registration first, then upload proof in the payment step." }, 400);
    }
    const { data: inserted, error: insertError } = await supabase.rpc("create_removerse_registration", {
      p_event_id: event.id, p_name: name, p_college: college, p_department: department,
      p_study_year: year, p_phone: phone, p_email: email, p_team: team, p_members: event.registration_type === "team" ? members : [name], p_rules_accepted: true,
    });
    const registration = Array.isArray(inserted) ? inserted[0] : inserted;
    if (insertError || !registration) {
      const message = insertError?.message || "";
      console.error("atomic registration insert failed", message);
      if (message.includes("DUPLICATE_EVENT_EMAIL")) return respond({ error: "This email already has a registration for this event. Use Check My Registration if you need to resubmit a rejected payment." }, 409);
      if (message.includes("EVENT_FULL")) return respond({ error: "Sorry, this event has reached its registration limit." }, 409);
      if (message.includes("EVENT_UNAVAILABLE")) return respond({ error: "This event is closed or unavailable." }, 400);
      if (message.includes("TEAM_REQUIRED")) return respond({ error: "Please enter your team name." }, 400);
      if (message.includes("TEAM_SIZE_INVALID")) return respond({ error: "The team member count does not match the event rules." }, 400);
      if (message.includes("TEAM_NOT_ALLOWED")) return respond({ error: "Team name is not accepted for this individual event." }, 400);
      if (message.includes("RULES_REQUIRED")) return respond({ error: "You must accept the event rules." }, 400);
      return respond({ error: "We could not save your registration. Please review the details and try again." }, 500);
    }
    if (!paid) {
      const resendKey = Deno.env.get("RESEND_API_KEY"), fromEmail = Deno.env.get("FROM_EMAIL");
      if (resendKey && fromEmail) {
        const safe = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]!));
        const site = Deno.env.get("SITE_URL") || "https://removerse-2027.vercel.app";
        const html = `<p>Hi ${safe(name)},</p><p>Your free registration for <strong>${safe(event.title)}</strong> is confirmed.</p><p>Registration code: ${safe(registration.registration_code)}<br>College: ${safe(college)}</p><p><a href="${safe(site)}/status.html">Check My Registration</a></p>`;
        try { const mail = await fetch("https://api.resend.com/emails", { method:"POST", headers:{Authorization:`Bearer ${resendKey}`,"Content-Type":"application/json"}, body:JSON.stringify({from:fromEmail,to:[email],subject:"REMOVERSE registration confirmed",html,text:`Your free registration for ${event.title} is confirmed. Registration code: ${registration.registration_code}. Check status: ${site}/status.html`}) }); if(!mail.ok) console.error("free confirmation email failed", await mail.text()); } catch(e) { console.error("free confirmation email exception", String(e)); }
      }
    }
    return respond({
      success: true, registrationCode: registration.registration_code, event: event.title, fee: registration.fee_inr,
      paymentStatus: registration.payment_status, registrationStatus: registration.registration_status,
      paymentRequired: paid,
      message: paid ? "Registration saved. Continue to the secure payment step to view the QR and upload proof." : "Free registration saved successfully.",
    }, 201);
  } catch (error) {
    if (uploadedPath && storageClient) {
      try { await storageClient.storage.from("removerse-payment-proofs").remove([uploadedPath]); } catch (_) { /* best-effort cleanup */ }
    }
    console.error("registration request failed", error instanceof Error ? error.message : "unknown error");
    return respond({ error: "Unable to process the registration. Please review the form and try again." }, 400);
  }
});