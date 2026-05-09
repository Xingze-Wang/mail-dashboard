import { SignJWT } from "jose";
const enc = new TextEncoder();
const secret = enc.encode(process.env.AUTH_SECRET);
const jwt = await new SignJWT({ repId: 999, repName: "GhostAdmin", email: "ghost@example.invalid", role: "admin" })
  .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("7d").sign(secret);
console.log(jwt);
