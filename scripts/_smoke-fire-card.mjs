// Sign an admin JWT and hit /api/admin/smoke-card on prod. Bypasses
// the Supabase reads-from-laptop problem by letting Vercel do them.
import { config } from "dotenv";
config({ path: ".env.local" });
import { SignJWT } from "jose";

const secret = process.env.AUTH_SECRET;
if (!secret) {
  console.error("AUTH_SECRET missing from .env.local");
  process.exit(1);
}
const jwt = await new SignJWT({
  repId: 5,
  repName: "Xingze",
  email: "xw2893@columbia.edu",
  role: "admin",
})
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime("1h")
  .sign(new TextEncoder().encode(secret));

const kind = process.argv[2] ?? "template";
const res = await fetch(`https://calistamind.com/api/admin/smoke-card?kind=${kind}`, {
  headers: { cookie: `qiji_session=${jwt}` },
});
const body = await res.text();
console.log("status:", res.status);
console.log("body:", body);
