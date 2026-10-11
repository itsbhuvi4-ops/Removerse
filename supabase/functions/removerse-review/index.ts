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
  const {data:r,error}=await db.from("registrations").select("id,fee_inr,payment_status").eq("id",id).maybeSingle();
  if(error||!r)return out({error:"Registration not found"},404);
  if(Number(r.fee_inr)<=0||r.payment_status!=="pending_verification")return out({error:"Only pending paid registrations can be reviewed"},409);
  const paid=action==="approve";
  const {error:updateError}=await db.from("registrations").update({payment_status:paid?"approved":"rejected",registration_status:paid?"confirmed":"rejected",reviewed_by:user.user.id,reviewed_at:new Date().toISOString(),review_note:paid?"Payment manually verified by organiser.":reason}).eq("id",id).eq("payment_status","pending_verification");
  if(updateError)return out({error:"Review update failed"},500);
  return out({success:true,status:paid?"approved":"rejected"});
 }catch(e){console.error("review failed",e instanceof Error?e.message:"unknown");return out({error:"Could not process review"},500);}
});