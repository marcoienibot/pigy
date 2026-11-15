import { describe, expect, it } from "vitest";
import {
  answerConsent,
  consentPage,
  createWorld,
  feed,
  isSimulatedSecret,
  memoryStorage,
  type SimPost,
  simulatedSecret,
  simulationNotice,
  table,
} from "./index.ts";

const start = new Date("2026-11-15T10:00:00Z");

function setup() {
  const storage = memoryStorage();
  const world = createWorld({ storage, now: () => start });
  return { storage, world };
}

describe("memoryStorage", () => {
  it("returns a copy of what was put, and keeps a copy of its own", () => {
    const storage = memoryStorage();
    const value = { list: [1] };
    storage.put("key", value);
    // Changing what was put, or what was read, must not change what is
    // stored: a Durable Object's storage behaves like this, and code that
    // relied on sharing the object would break there.
    value.list.push(2);
    (storage.get("key") as typeof value).list.push(3);
    expect(storage.get("key")).toEqual({ list: [1] });
  });

  it("lists the keys with a prefix, in order", () => {
    const storage = memoryStorage();
    for (const key of ["b/2", "a/10", "b/1", "a/9", "ab/1"]) {
      storage.put(key, key);
    }
    expect(Array.from(storage.list({ prefix: "a/" }), ([key]) => key)).toEqual([
      "a/10",
      "a/9",
    ]);
    expect(Array.from(storage.list({ prefix: "b/" }), ([key]) => key)).toEqual([
      "b/1",
      "b/2",
    ]);
  });

  it("says whether there was something to delete", () => {
    const storage = memoryStorage();
    storage.put("key", 1);
    expect(storage.delete("key")).toBe(true);
    expect(storage.delete("key")).toBe(false);
    expect(storage.get("key")).toBeUndefined();
  });
});

describe("table", () => {
  it("keeps its rows apart from those of other tables", () => {
    const storage = memoryStorage();
    const cats = table<string>(storage, "cat");
    const cattle = table<string>(storage, "cattle");
    cats.put("1", "Tom");
    cattle.put("1", "Daisy");
    // "cattle/1" begins with "cat", and is still none of the cats.
    expect(cats.all()).toEqual(["Tom"]);
    cats.delete("1");
    expect(cats.get("1")).toBeUndefined();
    expect(cattle.get("1")).toBe("Daisy");
  });
});

describe("the clock of a world", () => {
  it("starts at the clock it was given and moves when advanced", () => {
    const { world } = setup();
    expect(world.now()).toEqual(start);
    world.advance(90_000);
    world.advance(30_000);
    expect(world.now()).toEqual(new Date("2026-11-15T10:02:00Z"));
  });

  it("keeps the time it was advanced to in its storage", () => {
    const { storage, world } = setup();
    world.advance(60_000);
    // A world is made anew over the same storage for every request.
    expect(createWorld({ storage, now: () => start }).now()).toEqual(
      new Date("2026-11-15T10:01:00Z"),
    );
  });

  it("runs with the clock it was given", () => {
    let time = start;
    const world = createWorld({ now: () => time });
    world.advance(1000);
    time = new Date("2026-11-15T11:00:00Z");
    expect(world.now()).toEqual(new Date("2026-11-15T11:00:01Z"));
  });
});

describe("the tokens of a world", () => {
  const fields = {
    network: "mastodon" as const,
    accountId: "1",
    clientId: "client",
    scopes: ["read"],
  };

  it("issues tokens that say they are simulated", () => {
    const { world } = setup();
    const token = world.issueToken(fields);
    expect(isSimulatedSecret(token.token)).toBe(true);
    expect(world.findToken("mastodon", token.token)).toEqual(token);
    expect(world.tokenStatus(token)).toBe("valid");
  });

  it("does not find a token of another network", () => {
    const { world } = setup();
    const token = world.issueToken(fields);
    expect(world.findToken("threads", token.token)).toBeUndefined();
  });

  it("never finds a value that no simulator made", () => {
    const { storage, world } = setup();
    // Even if a real token got into the storage, by a mistake in the code
    // around the world, it would not be accepted.
    const real = "ZA-Yj3aBD8U8Cm7lKUp-lm9O9BmDgdhHzDeqsY8tlL0";
    storage.put(`token/mastodon/${real}`, { ...fields, token: real });
    expect(world.findToken("mastodon", real)).toBeUndefined();
  });

  it("keeps a revoked token on record, as revoked", () => {
    const { world } = setup();
    const token = world.issueToken(fields);
    world.revokeToken("mastodon", token.token);
    const found = world.findToken("mastodon", token.token);
    expect(found?.revoked).toBe(true);
    expect(found && world.tokenStatus(found)).toBe("revoked");
  });

  it("ends a token when the clock of the world reaches its end", () => {
    const { world } = setup();
    const hour = 60 * 60 * 1000;
    const token = world.issueToken({
      ...fields,
      expiresAt: start.getTime() + hour,
    });
    world.advance(hour - 1);
    expect(world.tokenStatus(token)).toBe("valid");
    // The end is the first moment at which the token is no longer good.
    world.advance(1);
    expect(world.tokenStatus(token)).toBe("expired");
  });

  it("ends a token before its time when told to, and keeps it on record", () => {
    const { world } = setup();
    const token = world.issueToken({
      ...fields,
      expiresAt: start.getTime() + 60 * 60 * 1000,
    });
    world.expireToken("mastodon", token.token);
    const found = world.findToken("mastodon", token.token);
    expect(found && world.tokenStatus(found)).toBe("expired");
    // Expired is not revoked: a network tells the two apart.
    expect(found?.revoked).toBe(false);
  });

  it("forgets the tokens whose end has passed when it issues another, and keeps the rest", () => {
    const { world } = setup();
    const hour = 60 * 60 * 1000;
    const ended = world.issueToken({
      ...fields,
      expiresAt: start.getTime() + hour,
    });
    const revoked = world.issueToken({
      ...fields,
      expiresAt: start.getTime() + 3 * hour,
    });
    world.revokeToken("mastodon", revoked.token);
    const lasting = world.issueToken(fields);
    world.advance(2 * hour);
    // Until another is issued, the world has all of them.
    expect(world.tokens("mastodon")).toHaveLength(3);
    const issued = world.issueToken(fields);
    expect(
      world
        .tokens("mastodon")
        .map(({ token }) => token)
        .sort(),
    ).toEqual([revoked.token, lasting.token, issued.token].sort());
    expect(world.findToken("mastodon", ended.token)).toBeUndefined();
  });

  it("calls a token that is both revoked and past its end revoked", () => {
    const { world } = setup();
    const token = world.issueToken({ ...fields, expiresAt: start.getTime() });
    world.revokeToken("mastodon", token.token);
    const found = world.findToken("mastodon", token.token);
    expect(found && world.tokenStatus(found)).toBe("revoked");
  });
});

describe("simulatedSecret", () => {
  it("makes a different secret every time", () => {
    expect(simulatedSecret()).not.toBe(simulatedSecret());
  });

  it("does not take a real secret for a simulated one", () => {
    expect(isSimulatedSecret("ya29.a0AfH6SMBx")).toBe(false);
    expect(isSimulatedSecret("")).toBe(false);
  });
});

describe("faults", () => {
  it("strike once, in the order they were armed", () => {
    const { world } = setup();
    world.faults.arm("mastodon", { kind: "server-error" });
    world.faults.arm("mastodon", { kind: "rate-limit" });
    const kinds = ["rate-limit", "server-error"] as const;
    expect(world.faults.take("mastodon", "publish", kinds)).toBe(
      "server-error",
    );
    expect(world.faults.take("mastodon", "publish", kinds)).toBe("rate-limit");
    expect(world.faults.take("mastodon", "publish", kinds)).toBeUndefined();
  });

  it("wait for a request of the kind they were armed for", () => {
    const { world } = setup();
    world.faults.arm("mastodon", {
      kind: "lost-response",
      operation: "publish",
    });
    expect(
      world.faults.take("mastodon", "read", ["lost-response"]),
    ).toBeUndefined();
    expect(world.faults.take("mastodon", "publish", ["lost-response"])).toBe(
      "lost-response",
    );
  });

  it("stay armed while no request can suffer from them", () => {
    const { world } = setup();
    world.faults.arm("mastodon", { kind: "token-revoked" });
    world.faults.arm("mastodon", { kind: "rate-limit" });
    // A request without a token has none to lose. It takes the fault it
    // can suffer from and leaves the other for a request that has one.
    expect(world.faults.take("mastodon", "instance", ["rate-limit"])).toBe(
      "rate-limit",
    );
    expect(world.faults.armed("mastodon")).toEqual([{ kind: "token-revoked" }]);
  });

  it("belong to one network", () => {
    const { world } = setup();
    world.faults.arm("mastodon", { kind: "rate-limit" });
    expect(
      world.faults.take("bluesky", "publish", ["rate-limit"]),
    ).toBeUndefined();
    world.faults.clear("mastodon");
    expect(world.faults.armed("mastodon")).toEqual([]);
  });

  it("are kept in the world, for a request that comes later", () => {
    const { storage, world } = setup();
    world.faults.arm("mastodon", { kind: "token-revoked" });
    const later = createWorld({ storage, now: () => start });
    expect(later.faults.take("mastodon", "publish", ["token-revoked"])).toBe(
      "token-revoked",
    );
  });
});

describe("feed", () => {
  const post = (id: string, createdAt: number, replyToId: string | null) =>
    ({
      network: "mastodon",
      id,
      accountId: "ada",
      text: `Post ${id}`,
      replyToId,
      createdAt,
      url: `https://mastodon.example/@ada/${id}`,
    }) satisfies SimPost;

  it("lists what is published, oldest first, with who posted it", () => {
    const { world } = setup();
    const account = {
      network: "mastodon" as const,
      id: "ada",
      handle: "@ada@mastodon.example",
      name: "Ada",
    };
    world.accounts("mastodon").put("ada", account);
    world.posts("mastodon").put("2", post("2", 2000, "1"));
    world.posts("mastodon").put("1", post("1", 1000, null));
    world.posts("mastodon").put("3", post("3", 2000, "2"));

    const entries = feed(world);
    expect(entries.map((entry) => entry.post.id)).toEqual(["1", "2", "3"]);
    // The chain of a thread can be followed from the replies.
    expect(entries.map((entry) => entry.post.replyToId)).toEqual([
      null,
      "1",
      "2",
    ]);
    expect(entries[0]?.account).toEqual(account);

    world.posts("mastodon").delete("3");
    expect(feed(world)).toHaveLength(2);
    expect(feed(world, ["bluesky"])).toEqual([]);
  });
});

describe("the consent page", () => {
  const options = {
    service: "Mastodon at mastodon.example",
    client: "pigy",
    scopes: ["write:statuses"],
    accounts: [{ id: "1", handle: "@ada@mastodon.example", name: "Ada" }],
  };

  it("says that it is a simulation", () => {
    expect(consentPage(options)).toContain(simulationNotice);
  });

  it("escapes what it is given", () => {
    const page = consentPage({
      ...options,
      client: "<script>alert(1)</script>",
      accounts: [{ id: '"><b>', handle: "<i>", name: "A & B" }],
    });
    expect(page).not.toContain("<script>");
    expect(page).not.toContain("<b>");
    expect(page).not.toContain("<i>");
    expect(page).toContain("A &amp; B");
  });
});

describe("answerConsent", () => {
  it("posts the answer and returns where the browser is sent", async () => {
    const seen: string[] = [];
    const url = await answerConsent(
      async (input, init) => {
        seen.push(await new Request(input, init).text());
        return new Response(null, {
          status: 302,
          headers: { Location: "https://app.example/callback?code=1" },
        });
      },
      "https://mastodon.example/oauth/authorize",
      { account: "42" },
    );
    expect(url.href).toBe("https://app.example/callback?code=1");
    expect(seen).toEqual(["account=42"]);
  });

  it("fails when the network shows a page instead", async () => {
    await expect(
      answerConsent(
        async () => new Response("No such client", { status: 401 }),
        "https://mastodon.example/oauth/authorize",
        "deny",
      ),
    ).rejects.toThrow("answered 401: No such client");
  });
});
