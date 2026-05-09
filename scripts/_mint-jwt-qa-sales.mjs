import { SignJWT } from "jose";
const enc = new TextEncoder();
const secret = enc.encode(process.env.AUTH_SECRET);
const jwt = await new SignJWT({ repId: 2, repName: "杜雨洁", email: "yujie@compute.miracleplus.com", role: "sales" })
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime("7d")
  .sign(secret);
console.log(jwt);
