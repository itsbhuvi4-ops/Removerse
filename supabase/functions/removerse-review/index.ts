import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const cors={"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const out=(v:unknown,s=200)=>new Response(JSON.stringify(v),{status:s,headers:cors});
Deno.serve(async req=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
 if(req.method!=="POST")return out({error:"Method not allowed"},405);
 const url=Deno.env.get("SUPABASE_URL"),secret=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
 if(!url||!secret)return out({error:"Service unavailable"},500);
 const token=(req.headers.get("authorization")||"").replace(/^Bearer\s+/i,"");
 if(!token)return out({error:"Sign in required"},401);
 const db=createClient(url,secret,{auth:{persistSession:false}});
 const authClient=createClient(url,Deno.env.get("SUPABASE_ANON_KEY")||Deno.env.get("SUPABASE_PUBLISHABLE_KEY")||secret,{auth:{persistSession:false}});
 const {data:user,error:authError}=await authClient.auth.getUser(token);
 if(authError||!user.user)return out({error:"Session expired"},401);
 const {data:profile}=await db.from("profiles").select("role").eq("user_id",user.user.id).maybeSingle();
 if(profile?.role!=="admin")return out({error:"Admin role required"},403);
 try{
  const b=await req.json(),id=String(b.id||""),action=String(b.action||""),reason=String(b.reason||"").trim().slice(0,500);
  if(!id||!["approve","reject"].includes(action))return out({error:"Invalid action"},400);
  if(action==="reject"&&!reason)return out({error:"Rejection reason is required"},400);
  const {data:r,error}=await db.from("registrations").select("id,fee_inr,payment_status,payment_proof_path").eq("id",id).maybeSingle();
  if(error||!r)return out({error:"Registration not found"},404);
  if(Number(r.fee_inr)<=0||r.payment_status!=="pending_verification")return out({error:"Only pending paid registrations can be reviewed"},409);
  if(action==="approve"&&!r.payment_proof_path)return out({error:"A payment screenshot must be uploaded before approval"},409);
  const paid=action==="approve";
  const {data:updated,error:updateError}=await db.from("registrations").update({payment_status:paid?"approved":"rejected",registration_status:paid?"confirmed":"rejected",reviewed_by:user.user.id,reviewed_at:new Date().toISOString(),review_note:paid?"Payment manually verified by organiser.":reason}).eq("id",id).eq("payment_status","pending_verification").select("id").maybeSingle();
  if(updateError)return out({error:"Review update failed"},500);
  if(!updated)return out({error:"This payment was already reviewed. Refresh the dashboard before trying again."},409);
  const {data:details}=await db.from("registrations").select("registration_code,email,participant_name,team_name,fee_inr,events(title,event_date,venue)").eq("id",id).maybeSingle();
  const resend=Deno.env.get("RESEND_API_KEY"),from=Deno.env.get("FROM_EMAIL"),site=Deno.env.get("SITE_URL")||"https://removerse-2027.vercel.app";
  let emailSent=false;
  if(resend&&from&&details){
    const esc=(v:unknown)=>String(v??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]!));
    const ev=Array.isArray(details.events)?details.events[0]:details.events;
    const team=details.team_name||details.participant_name;
    const pass=JSON.stringify({registrationId:details.registration_code,team,event:ev?.title||"",date:ev?.event_date||"",venue:ev?.venue||""});
    const html=paid
      ? `<h2>Thank you for registering — REMOVERSE 2027!</h2><p>Hi ${esc(details.participant_name)}, thank you for registering for ${esc(ev?.title||"REMOVERSE 2027")}.</p><p>Our organising team has manually verified your payment, and your registration is now confirmed.</p><p><strong>Payment Status:</strong> Approved<br><strong>Registration Status:</strong> Confirmed<br>Team/participant: ${esc(team)}<br>Registration code: ${esc(details.registration_code)}<br>Event date: ${esc(ev?.event_date||"See official schedule")}<br>Venue: ${esc(ev?.venue||"See official event details")}</p><p>Your registration code is your reference. Check your latest status and boarding pass here:</p><p><a href="${esc(site)}/status.html">Check My Registration</a></p>`
      : `<h2>Payment needs correction</h2><p>Hi ${esc(details.participant_name)}, your payment for ${esc(ev?.title||"the event")} was not approved.</p><p>Reason: ${esc(reason)}</p><p>Use Check My Registration to view the status and start a secure resubmission.</p><p><a href="${esc(site)}/status.html">Check My Registration</a></p>`;
    const text=paid?`Thank you for registering for ${ev?.title||"REMOVERSE 2027"}. Your payment has been manually verified and your registration is confirmed. Payment Status: Approved. Registration Status: Confirmed. Team/participant: ${team}. Registration code: ${details.registration_code}. Event date: ${ev?.event_date||"See official schedule"}. Venue: ${ev?.venue||"See official event details"}. Check your registration and boarding pass: ${site}/status.html` :`Payment not approved for ${ev?.title||"event"}. Reason: ${reason}. ${site}/status.html`;
    try{const mail=await fetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:`Bearer ${resend}`,"Content-Type":"application/json"},body:JSON.stringify({from,to:[details.email],subject:paid?"Thank you for registering — REMOVERSE 2027 confirmed":"REMOVERSE payment requires correction",html,text})});if(!mail.ok)console.error("review notification failed",await mail.text());else emailSent=true;}catch(e){console.error("review email exception",String(e));}
  }
  return out({success:true,status:paid?"approved":"rejected",emailSent});
 }catch(e){console.error("review failed",e instanceof Error?e.message:"unknown");return out({error:"Could not process review"},500);}
});