import { SignJWT } from "jose";
const enc = new TextEncoder();
const secret = enc.encode("garbage-not-the-real-secret-1234567890");
const jwt = await new SignJWT({ repId: 5, repName: "Xingze", email: "xw2893@columbia.edu", role: "admin" })
  .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("7d").sign(secret);
console.log(jwt);
