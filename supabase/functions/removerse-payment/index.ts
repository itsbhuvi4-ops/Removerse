import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const cors={"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS"};
const json=(b:unknown,s=200)=>new Response(JSON.stringify(b),{status:s,headers:cors});
const esc=(v:unknown)=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
const validImage=(type:string,b:Uint8Array)=>type==="image/jpeg"&&b.length>3&&b[0]===255&&b[1]===216&&b[2]===255||type==="image/png"&&b.length>=8&&[137,80,78,71,13,10,26,10].every((v,i)=>b[i]===v)||type==="image/webp"&&b.length>=12&&String.fromCharCode(...b.slice(0,4))==="RIFF"&&String.fromCharCode(...b.slice(8,12))==="WEBP";
Deno.serve(async req=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
 if(req.method!=="POST")return json({error:"Method not allowed"},405);
 const url=Deno.env.get("SUPABASE_URL"),key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
 if(!url||!key)return json({error:"Payment service is not configured"},500);
 const db=createClient(url,key,{auth:{persistSession:false}});
 let path:string|null=null;
 try{
  const type=req.headers.get("content-type")||"";
  let action="",code="",email="",form:FormData|null=null,body:any={};
  if(type.includes("multipart/form-data")){form=await req.formData();action=String(form.get("action")||"upload");code=String(form.get("registrationCode")||"").trim();email=String(form.get("email")||"").trim().toLowerCase();}
  else{body=await req.json();action=String(body.action||"start");code=String(body.registrationCode||"").trim();email=String(body.email||"").trim().toLowerCase();}
  if(!code||!email||!/^\S+@\S+\.\S+$/.test(email))return json({error:"Registration code and valid email are required."},400);
  const {data:r,error}=await db.from("registrations").select("id,registration_code,email,participant_name,team_name,college,event_id,fee_inr,payment_status,registration_status,payment_proof_path,uploaded_at,events(title)").eq("registration_code",code).ilike("email",email).maybeSingle();
  if(error||!r)return json({error:"Registration could not be verified. Check the code and email."},404);
  if(Number(r.fee_inr)<=0)return json({error:"This is a free event; no payment is required."},400);
  if(r.payment_status==="approved")return json({error:"This registration is not accepting a new payment countdown."},409);
  if(action==="start"){
   const startedAt=new Date().toISOString();
   const {error:upErr}=await db.from("registrations").update({payment_started_at:startedAt}).eq("id",r.id).in("payment_status",["pending_verification","rejected"]);
   if(upErr)return json({error:"Could not start payment timer."},500);
   const {data:setting}=await db.from("settings").select("value").eq("key","payment_qr_path").maybeSingle();
   const {data:countdown}=await db.from("settings").select("value").eq("key","payment_countdown_seconds").maybeSingle();
   let qrUrl:string|null=null;
   const qrPath=typeof setting?.value==="string"?setting.value:setting?.value?.path;
   if(qrPath){const {data:signed}=await db.storage.from("removerse-payment-qr").createSignedUrl(qrPath,300);qrUrl=signed?.signedUrl||null;}
   return json({success:true,paymentStartedAt:startedAt,countdownSeconds:Math.max(10,Number(countdown?.value??30)||30),qrUrl,fee:Number(r.fee_inr),event:(Array.isArray(r.events)?r.events[0]:r.events)?.title||"REMOVERSE Event"});
  }
  if(action==="upload"){
   if(!form)return json({error:"Upload a payment screenshot."},400);
   const proof=form.get("proof");
   if(!(proof instanceof File)||proof.size<1)return json({error:"Choose a payment screenshot."},400);
   if(proof.size>5*1024*1024)return json({error:"Screenshot must be 5 MB or smaller."},400);
   if(!["image/jpeg","image/png","image/webp"].includes(proof.type))return json({error:"Only JPG, PNG or WebP screenshots are accepted."},400);
   const bytes=new Uint8Array(await proof.arrayBuffer());if(!validImage(proof.type,bytes))return json({error:"The file content does not match its image type."},400);
   const ext=proof.type==="image/png"?"png":proof.type==="image/webp"?"webp":"jpg";
   path=`pending/${crypto.randomUUID()}/proof.${ext}`;
   const {error:storageError}=await db.storage.from("removerse-payment-proofs").upload(path,proof,{contentType:proof.type,upsert:false});
   if(storageError){console.error("proof upload failed",storageError.message);path=null;return json({error:"Could not upload screenshot. Try again."},500);}
   const uploadedAt=new Date().toISOString();
   const {error:updateError}=await db.from("registrations").update({payment_proof_path:path,uploaded_at:uploadedAt,payment_status:"pending_verification",registration_status:"pending",admin_reminder_sent:false,review_note:null,reviewed_by:null,reviewed_at:null}).eq("id",r.id).in("payment_status",["pending_verification","rejected"]);
   if(updateError){await db.storage.from("removerse-payment-proofs").remove([path]);path=null;console.error("proof record update failed",updateError.message);return json({error:"Screenshot uploaded but could not be attached. Please retry."},500);}
   const resend=Deno.env.get("RESEND_API_KEY"),from=Deno.env.get("FROM_EMAIL"),admin=Deno.env.get("ADMIN_EMAIL"),site=Deno.env.get("SITE_URL")||"https://removerse-2027.vercel.app";
   if(resend&&from){
    const event=(Array.isArray(r.events)?r.events[0]:r.events)?.title||"REMOVERSE Event",team=r.team_name||r.participant_name;
    const html=`<p>Hi ${esc(r.participant_name)},</p><p>Thank you for registering for <strong>${esc(event)}</strong>.</p><p>Team/participant: ${esc(team)}<br>Fee: ₹${esc(r.fee_inr)}<br>Registration code: ${esc(r.registration_code)}</p><p>Your payment proof was received. The organisers will verify it within 24 hours.</p><p><a href="${esc(site)}/status.html">Check My Registration</a></p>`;
    const textBody=`Thank you for registering for ${event}. Team/participant: ${team}. Fee: ₹${r.fee_inr}. Registration code: ${r.registration_code}. Your payment will be verified within 24 hours. Check My Registration: ${site}/status.html`;
    try{const m=await fetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:`Bearer ${resend}`,"Content-Type":"application/json"},body:JSON.stringify({from,to:[r.email],subject:"REMOVERSE registration received",html,text:textBody})});if(!m.ok)console.error("student payment email failed",await m.text());}catch(e){console.error("student payment email exception",String(e));}
    if(admin){try{const {data:signed}=await db.storage.from("removerse-payment-proofs").createSignedUrl(path,60*60);const adminHtml=`<p>New payment proof received.</p><p>Team: ${esc(team)}<br>Event: ${esc(event)}<br>College: ${esc((r as any).college)}<br>Fee: ₹${esc(r.fee_inr)}<br>Registration: ${esc(r.registration_code)}</p><p><a href="${esc(signed?.signedUrl||"")}">View proof (expires in 1 hour)</a></p><p><a href="${esc(site)}/admin">Open admin dashboard</a></p>`;const m=await fetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:`Bearer ${resend}`,"Content-Type":"application/json"},body:JSON.stringify({from,to:[admin],subject:`REMOVERSE proof: ${team} · ${event}`,html:adminHtml,text:`Team: ${team}; event: ${event}; college: ${(r as any).college}; fee ₹${r.fee_inr}; proof link: ${signed?.signedUrl||"unavailable"}; dashboard: ${site}/admin`})});if(!m.ok)console.error("admin payment email failed",await m.text());}catch(e){console.error("admin payment email exception",String(e));}}
   }
   return json({success:true,message:"Registration received. Your payment will be verified within 24 hours.",uploadedAt},200);
  }
  return json({error:"Unsupported payment action."},400);
 }catch(e){if(path){try{const url=Deno.env.get("SUPABASE_URL"),key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");if(url&&key)await createClient(url,key).storage.from("removerse-payment-proofs").remove([path]);}catch{}}console.error("payment handler failed",e instanceof Error?e.message:"unknown");return json({error:"Unable to process payment step."},500);}
});
