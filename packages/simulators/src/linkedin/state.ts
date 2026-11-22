import type {
  SimAccount,
  SimImageType,
  SimPost,
  SimToken,
  SimWorld,
  Table,
} from "../world/index.ts";

/** Somebody with a profile on the simulated LinkedIn. */
export type LinkedInMember = SimAccount & {
  network: "linkedin";
  givenName: string;
  familyName: string;
};

/**
 * An application as a developer has made it in LinkedIn's developer
 * portal: there is no API to register one.
 */
export type LinkedInClient = {
  clientId: string;
  clientSecret: string;
  /** What the consent page calls it. */
  name: string;
  /** The redirect addresses that were entered for it, each in full. */
  redirectUris: string[];
  /**
   * The permissions that the products of the application give it: "Share
   * on LinkedIn" has `w_member_social`, "Sign In with LinkedIn using
   * OpenID Connect" has `openid`, `profile` and `email`.
   */
  scopes: string[];
};

export type LinkedInToken = SimToken & {
  network: "linkedin";
  /** In milliseconds since the epoch. */
  createdAt: number;
};

export type LinkedInPost = SimPost & {
  network: "linkedin";
  visibility: string;
};

/**
 * An image of the Images API: what `initializeUpload` makes, which the
 * bytes are put into at the address that it hands out, and which a post
 * then names by its URN.
 */
export type LinkedInImage = {
  /** Its URN, `urn:li:image:…`. */
  id: string;
  /** The member whose image it is, who alone can post it. */
  ownerId: string;
  /**
   * What lets the bytes in: the last part of the address that the upload
   * goes to. Good once.
   */
  uploadToken: string;
  /** In milliseconds since the epoch. */
  createdAt: number;
  /**
   * The bytes, once they have arrived, with what LinkedIn found in them,
   * or why it could not take them.
   */
  file:
    | {
        blob: string;
        type: SimImageType;
        width: number;
        height: number;
        size: number;
      }
    | { failed: string }
    | null;
  /**
   * Until when LinkedIn works on the bytes after they arrived, in
   * milliseconds since the epoch.
   */
  readyAt: number;
};

/** What a member consented to, until it is exchanged for a token. */
export type Code = {
  clientId: string;
  memberId: string;
  redirectUri: string;
  scopes: string[];
  /** In milliseconds since the epoch. */
  expiresAt: number;
};

/** The state of the simulated LinkedIn, all of it in the world. */
export type State = {
  world: SimWorld;
  members: Table<LinkedInMember>;
  clients: Table<LinkedInClient>;
  codes: Table<Code>;
  posts: Table<LinkedInPost>;
  /** The images of the Images API, by their URN. */
  images: Table<LinkedInImage>;
  /** The posts that were deleted, by their ID. */
  deleted: Table<true>;
  /** How often something was done on the day it is counted for. */
  counters: Table<{ day: number; count: number }>;
};

export function createState(world: SimWorld): State {
  return {
    world,
    members: world.accounts("linkedin"),
    clients: world.table("linkedin", "client"),
    codes: world.table("linkedin", "code"),
    posts: world.posts("linkedin"),
    images: world.table("linkedin", "image"),
    deleted: world.table("linkedin", "deleted"),
    counters: world.table("linkedin", "counter"),
  };
}

/** How long an access token lasts: 60 days, as LinkedIn documents. */
export const accessTokenLifetimeMs = 60 * 24 * 60 * 60 * 1000;

/** How long an authorization code lasts: 30 minutes, as documented. */
export const codeLifetimeMs = 30 * 60 * 1000;

/**
 * For how long LinkedIn refuses a post of the same author with the same
 * text as one that is there. GUESS: ten minutes. LinkedIn documents the
 * refusal and not for how long it looks back.
 */
export const duplicateWindowMs = 10 * 60 * 1000;

/** The scopes of a list as LinkedIn takes one: separated by spaces. */
export function parseScopes(value: string): string[] {
  return value.split(" ").filter(Boolean);
}
