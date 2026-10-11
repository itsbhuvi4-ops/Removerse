import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const headers = { "Content-Type":"application/json", "Access-Control-Allow-Origin":"*", "Access-Control-Allow-Headers":"authorization, apikey, content-type", "Access-Control-Allow-Methods":"POST, OPTIONS" };
const json = (body: unknown, status=200) => new Response(JSON.stringify(body), { status, headers });
const hash = async (v: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)))).map(b=>b.toString(16).padStart(2,"0")).join("");
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
const normPhone = (v: string) => v.replace(/[^\d+]/g,"").slice(-15);

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok",{headers});
  if (req.method !== "POST") return json({error:"Method not allowed"},405);
  const url=Deno.env.get("SUPABASE_URL"), key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), resend=Deno.env.get("RESEND_API_KEY"), from=Deno.env.get("FROM_EMAIL");
  if(!url||!key||!resend||!from) return json({error:"Server configuration is incomplete"},500);
  const db=createClient(url,key,{auth:{persistSession:false}});
  try {
    const body=await req.json(); const action=String(body.action||"");
    const lookup=String(body.lookup||"").trim().slice(0,254);
    if(action==="request") {
      if(!lookup) return json({error:"Enter your registration email or phone."},400);
      const emailLookup=lookup.includes("@");
      let query=db.from("registrations").select("email").limit(1);
      query=emailLookup?query.ilike("email",lookup):query.eq("phone",lookup);
      const {data}=await query.maybeSingle();
      // Always return the same response to prevent registration enumeration.
      if(data?.email) {
        const rateCutoff=new Date(Date.now()-15*60*1000).toISOString();
        const {count:recentCodes}=await db.from("registration_access_codes").select("id",{count:"exact",head:true}).eq("delivery_email",data.email).gte("created_at",rateCutoff);
        if((recentCodes||0)>=5) return json({success:true,message:"If a registration matches those details, a verification code has been sent.",requestId:null});
        const code=String(crypto.getRandomValues(new Uint32Array(1))[0]%1000000).padStart(6,"0");
        const lookupHash=await hash((emailLookup?lookup.toLowerCase():normPhone(lookup))+"|"+crypto.randomUUID());
        const {data:stored,error:challengeError}=await db.from("registration_access_codes").insert({lookup_hash:lookupHash,delivery_email:data.email,code_hash:await hash(code),expires_at:new Date(Date.now()+10*60*1000).toISOString()}).select("id").single();
        if(challengeError){console.error("status challenge insert failed",challengeError.message);return json({error:"Could not send a verification code. Try again."},500);}
        // The opaque request handle contains no email or registration data.
        const mail=await fetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:`Bearer ${resend}`,"Content-Type":"application/json"},body:JSON.stringify({from,to:[data.email],subject:"Your REMOVERSE registration access code",html:`<p>Your one-time code is <strong>${code}</strong>.</p><p>It expires in 10 minutes. If you did not request it, ignore this email.</p>`,text:`Your REMOVERSE one-time code is ${code}. It expires in 10 minutes.`})});
        if(!mail.ok) {
          const providerError = await mail.text();
          console.error("status OTP email failed", providerError);
          if (stored?.id) await db.from("registration_access_codes").delete().eq("id", stored.id);
          return json({error:"Verification email could not be sent. Please check the organiser email configuration and try again."},502);
        }
        return json({success:true,message:"If a registration matches those details, a verification code has been sent.",requestId:stored?.id||null});
      }
      return json({success:true,message:"If a registration matches those details, a verification code has been sent.",requestId:null});
    }
    if(action==="verify") {
      const requestId=String(body.requestId||""); const code=String(body.code||"").trim();
      if(!/^[0-9]{6}$/.test(code)||!requestId) return json({error:"Enter the six-digit code from your email."},400);
      const {data:challenge}=await db.from("registration_access_codes").select("*").eq("id",requestId).is("consumed_at",null).gt("expires_at",new Date().toISOString()).lt("attempts",6).maybeSingle();
      if(!challenge) return json({error:"The code expired or is invalid. Request a new one."},401);
      if(await hash(code)!==challenge.code_hash) {
        await db.from("registration_access_codes").update({attempts:challenge.attempts+1}).eq("id",challenge.id);
        return json({error:"The code is incorrect."},401);
      }
      await db.from("registration_access_codes").update({consumed_at:new Date().toISOString()}).eq("id",challenge.id);
      const {data:registrations,error}=await db.from("registrations")
        .select("id,registration_code,participant_name,team_name,college,email,phone,fee_inr,payment_status,registration_status,created_at,uploaded_at,review_note,arrived_at,events(title,slug,event_date,venue)")
        .ilike("email",challenge.delivery_email).order("created_at",{ascending:false}).limit(100);
      if(error) { console.error("status query failed",error.message); return json({error:"Could not load registrations."},500); }
      return json({success:true,registrations:(registrations||[]).map(r=>({...r,boardingPassPayload:JSON.stringify({registrationId:r.registration_code,team:r.team_name||r.participant_name,event:(Array.isArray(r.events)?r.events[0]:r.events)?.title||"",date:(Array.isArray(r.events)?r.events[0]:r.events)?.event_date||"",venue:(Array.isArray(r.events)?r.events[0]:r.events)?.venue||""})}))});
    }
    return json({error:"Unsupported action"},400);
  } catch(e) { console.error("status request failed",e instanceof Error?e.message:"unknown"); return json({error:"Unable to process request."},500); }
});
