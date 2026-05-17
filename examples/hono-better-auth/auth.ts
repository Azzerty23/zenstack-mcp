import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";
import { zenstackAdapter } from "@zenstackhq/better-auth";
import { db } from "./db";

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  secret: process.env.BETTER_AUTH_SECRET ?? "dev-secret-change-in-production",
  database: zenstackAdapter(db, { provider: "sqlite" }),
  plugins: [bearer()],
  emailAndPassword: { enabled: true },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
  },
});
