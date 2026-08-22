// Sign-in for the panel: password, then a TOTP code, in that order.
//
// None of this is the security boundary. public.is_admin() in the database
// is, and it requires three things at once — a uid on private.admins, an
// `aal2` claim in the token (which only a passed TOTP challenge produces),
// and the token's email still matching the allowlist row. Everything here
// just walks a person through getting a session that satisfies it, and shows
// them where they are stuck when it doesn't.
//
// Password rather than an emailed code, which is what the plan originally
// called for, for two practical reasons that only turned up on contact with
// Supabase: the built-in SMTP on the free tier is rate limited to a handful
// of messages an hour and is explicitly not meant for production, so a bad
// morning could mean being locked out of your own dashboard by your own
// retries; and a six-digit code needs the email template edited by hand to
// include the token, which is one more thing to do on a phone. With TOTP
// mandatory this is two factors either way, and it is the one that cannot
// fail because an inbox was slow.
//
// Copy here is English, like the rest of the panel. Only the app is
// Portuguese.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../app/config.js';

export var sb = null;

export function init(){
  if(!SUPABASE_URL || !SUPABASE_ANON_KEY) return "no-config";
  if(!window.supabase) return "no-script";
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  return null;
}

export async function session(){
  var r = await sb.auth.getSession();
  return r.data ? r.data.session : null;
}

export function uid(s){ return s && s.user ? s.user.id : null; }
export function email(s){ return s && s.user ? s.user.email : null; }

// Where the person is, in one word, so main.js can pick a screen without
// knowing anything about Supabase's MFA object model.
//
//   anon        — not signed in
//   needs-enrol — signed in, no verified second factor yet
//   needs-mfa   — signed in, a factor exists, the challenge is still owed
//   ready       — aal2; whether they are an *admin* is the database's answer,
//                 not ours, and main.js finds out by asking it
export async function state(){
  var s = await session();
  if(!s) return "anon";

  var aal = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  var cur = aal.data ? aal.data.currentLevel : null;
  var next = aal.data ? aal.data.nextLevel : null;

  if(cur === "aal2") return "ready";
  // nextLevel only reaches aal2 once a factor has been verified, so this is
  // also the test for "has anything been enrolled at all".
  if(next === "aal2") return "needs-mfa";
  return "needs-enrol";
}

export async function signIn(emailValue, password){
  var r = await sb.auth.signInWithPassword({ email: emailValue, password: password });
  if(r.error) throw r.error;
  return r.data;
}

export async function signOut(){
  await sb.auth.signOut();
}

async function totpFactor(verifiedOnly){
  var r = await sb.auth.mfa.listFactors();
  if(r.error) throw r.error;
  var all = (r.data && r.data.all) || [];
  var totp = all.filter(function(f){
    return f.factor_type === "totp" && (!verifiedOnly || f.status === "verified");
  });
  return totp[0] || null;
}

export async function verify(code){
  var f = await totpFactor(true);
  if(!f) throw new Error("No active second factor.");
  var r = await sb.auth.mfa.challengeAndVerify({ factorId: f.id, code: code });
  if(r.error) throw r.error;
  return r.data;
}

// Enrolling twice leaves an unverified factor behind each time, and Supabase
// counts those against the factor limit — so a few abandoned attempts would
// eventually make it impossible to enrol at all. Clear them first.
export async function enrol(){
  var r = await sb.auth.mfa.listFactors();
  if(r.error) throw r.error;
  var stale = ((r.data && r.data.all) || []).filter(function(f){
    return f.factor_type === "totp" && f.status !== "verified";
  });
  for(var i = 0; i < stale.length; i++){
    await sb.auth.mfa.unenroll({ factorId: stale[i].id });
  }

  var e = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: "VoltaCheck" });
  if(e.error) throw e.error;
  return { id: e.data.id, qr: e.data.totp.qr_code, secret: e.data.totp.secret };
}

export async function confirmEnrol(factorId, code){
  var r = await sb.auth.mfa.challengeAndVerify({ factorId: factorId, code: code });
  if(r.error) throw r.error;
  return r.data;
}

// Supabase's own error strings are often internal ("AuthApiError: ..."). These
// are the ones a person can actually act on; anything else falls through to
// its own text, because a wrong-but-friendly message is worse than an
// odd-but-true one.
export function readable(err){
  var m = String((err && err.message) || err || "");
  if(/Invalid login credentials/i.test(m)) return "Wrong email or password.";
  if(/Email not confirmed/i.test(m))       return "Confirm your email address first.";
  if(/Signups not allowed|not allowed for otp/i.test(m))
    return "That account does not exist. Sign-ups are disabled, on purpose.";
  if(/Invalid TOTP code|invalid code/i.test(m)) return "Wrong or expired code.";
  if(/rate limit|too many/i.test(m))       return "Too many attempts. Wait a moment.";
  if(/Failed to fetch|NetworkError/i.test(m)) return "No connection to the database.";
  return m || "Something went wrong.";
}
