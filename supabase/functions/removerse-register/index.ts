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
    if (event.registration_type === "individual" && team) return respond({ error: "Team name is not accepted for this event." }, 400);
    const paid = Number(event.fee_inr) > 0;
    const proof = form.get("proof");
    if (paid) {
      if (utr.length < 6) return respond({ error: "Enter the UPI transaction reference (UTR)." }, 400);
      if (!(proof instanceof File) || proof.size < 1) return respond({ error: "Upload your payment screenshot or PDF." }, 400);
      if (!["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(proof.type)) return respond({ error: "Payment proof must be JPG, PNG, WebP or PDF." }, 400);
      if (proof.size > 5 * 1024 * 1024) return respond({ error: "Payment proof must be 5 MB or smaller." }, 400);
      const bytes = new Uint8Array(await proof.arrayBuffer());
      if (!signatureMatches(proof.type, bytes)) return respond({ error: "The uploaded file does not match its declared type." }, 400);
      const ext = proof.type === "application/pdf" ? "pdf" : proof.type === "image/png" ? "png" : proof.type === "image/webp" ? "webp" : "jpg";
      uploadedPath = `pending/${crypto.randomUUID()}/proof.${ext}`;
      const { error: uploadError } = await supabase.storage.from("removerse-payment-proofs").upload(uploadedPath, proof, { contentType: proof.type, upsert: false });
      if (uploadError) {
        console.error("proof upload failed", uploadError.message);
        uploadedPath = null;
        return respond({ error: "Payment proof upload failed. Please try again." }, 500);
      }
    }
    const { data: registration, error: insertError } = await supabase.from("registrations").insert({
      event_id: event.id, participant_name: name, college, department, study_year: year, phone, email,
      team_name: team || null, utr: paid ? utr : null, payment_proof_path: uploadedPath, fee_inr: Number(event.fee_inr),
      payment_status: paid ? "pending_verification" : "not_required",
      registration_status: paid ? "pending" : "confirmed", rules_accepted: true,
    }).select("registration_code,fee_inr,payment_status,registration_status").single();
    if (insertError || !registration) {
      if (uploadedPath) await supabase.storage.from("removerse-payment-proofs").remove([uploadedPath]);
      uploadedPath = null;
      console.error("registration insert failed", insertError?.message);
      return respond({ error: "We could not save your registration. Please try again." }, 500);
    }
    return respond({
      success: true, registrationCode: registration.registration_code, event: event.title, fee: registration.fee_inr,
      paymentStatus: registration.payment_status, registrationStatus: registration.registration_status,
      message: paid ? "Registration received. Payment is pending manual organiser verification." : "Free registration saved successfully.",
    }, 201);
  } catch (error) {
    if (uploadedPath && storageClient) {
      try { await storageClient.storage.from("removerse-payment-proofs").remove([uploadedPath]); } catch (_) { /* best-effort cleanup */ }
    }
    console.error("registration request failed", error instanceof Error ? error.message : "unknown error");
    return respond({ error: "Unable to process the registration. Please review the form and try again." }, 400);
  }
});