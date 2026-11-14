import { z } from "zod";
import { emailSchema } from "./email.ts";

export const roleSchema = z.enum(["admin", "member"]);

export type Role = z.infer<typeof roleSchema>;

/** Response of `GET /api/me`: who is signed in. */
export const meResponseSchema = z.object({
  user: z.object({
    id: z.string().min(1),
    email: z.string().min(1),
    name: z.string().min(1),
  }),
  role: roleSchema,
});

export type MeResponse = z.infer<typeof meResponseSchema>;

/**
 * Why a sign-in did not complete. The Worker puts it in the `error` query
 * parameter of the sign-in page.
 */
export const signInErrorSchema = z.enum([
  /** Cancelled, expired, replayed or refused by Google. Trying again helps. */
  "failed",
  /** Google has not verified the email address of the account. */
  "email_not_verified",
  /** The server has no Google credentials. */
  "not_configured",
]);

export type SignInError = z.infer<typeof signInErrorSchema>;

/** One email address that may sign in. */
export const allowedEmailSchema = z.object({
  email: z.string().min(1),
  role: roleSchema,
  /**
   * True for the addresses in the `ADMIN_EMAILS` variable. They are always
   * admins and cannot be changed or removed through the API.
   */
  fixed: z.boolean(),
  /** Whether somebody has signed in with this address yet. */
  signedIn: z.boolean(),
});

export type AllowedEmail = z.infer<typeof allowedEmailSchema>;

/** Response of `GET /api/admin/allowed-emails`. */
export const allowedEmailListResponseSchema = z.object({
  allowedEmails: z.array(allowedEmailSchema),
});

/** Body of `POST /api/admin/allowed-emails`. */
export const addAllowedEmailRequestSchema = z.object({
  email: emailSchema,
  role: roleSchema,
});

export type AddAllowedEmailRequest = z.infer<
  typeof addAllowedEmailRequestSchema
>;

/** Body of `PATCH /api/admin/allowed-emails/:email`. */
export const updateAllowedEmailRequestSchema = z.object({
  role: roleSchema,
});
