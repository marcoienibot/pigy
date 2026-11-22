import {
  idSchema,
  maxUploadChunks,
  maxWorkspaceMediaBytes,
  uploadChunkBytes,
  uploadChunkRange,
  uploadChunks,
  uploadCompleteSchema,
  uploadRequestsPerMinute,
  uploadStateSchema,
} from "@pigy/core";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { isLocal } from "../auth/config.ts";
import { requireUser } from "../auth/guards.ts";
import { uploadUses } from "../db/schema.ts";
import type { AppDependencies, AppEnv } from "../env.ts";
import { loggable } from "../log.ts";
import type { MediaUpload, WorkspaceIdentity } from "../workspace/store.ts";
import {
  beginUpload,
  finishUpload,
  mediaUploadOf,
  ownWorkspace,
  uploadedPart,
} from "../workspace/workspaces.ts";
import { forgetUpload, takeIn } from "./intake.ts";
import { mediaKeys } from "./keys.ts";
import { mediaLinkPath, mediaLinksWith } from "./links.ts";
import { imagesTransformer } from "./transform.ts";

/**
 * The routes that the bytes of images travel through: up, in chunks, to a
 * row of `media` that the workspace has, and down, to the owner of the
 * workspace. @pigy/core has the protocol of an upload, in
 * src/media/upload.ts.
 *
 * The Worker talks to the bucket, and the object of the workspace keeps
 * the rows and what is known of an upload: no byte of an image crosses
 * into an object or out of one.
 *
 * Every byte of the bucket that leaves pigy leaves here: to whoever is
 * signed in as the owner of the workspace, and, at a link that pigy has
 * signed and that expires, to a network that fetches the images of a
 * post, links.ts. The bucket has no address of its own.
 */

const minuteMs = 60_000;

/** The headers that every image is served with. */
function imageHeaders(file: R2Object, name: string): Headers {
  const type = file.httpMetadata?.contentType ?? "application/octet-stream";
  return new Headers({
    // What the server found in the bytes when it took the image in, and
    // nothing that a browser may make something else of.
    "Content-Type": type,
    "X-Content-Type-Options": "nosniff",
    // Shown where a page of pigy puts it, as a picture, and saved by a
    // browser that is sent to the address itself: never a page.
    "Content-Disposition": `attachment; filename="${name}.${type.slice(type.indexOf("/") + 1)}"`,
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Length": String(file.size),
    "Cache-Control": "no-store",
  });
}

export function mediaRoutes(dependencies: AppDependencies): Hono<AppEnv> {
  const { now, developmentCredentialKeys } = dependencies;
  const app = new Hono<AppEnv>();
  // Also refuses a request that changes something and does not come from
  // pigy's own pages.
  const signedIn = requireUser(dependencies);

  /** The workspace in the path, which has to be the caller's. */
  const workspaceOf = async (c: Context<AppEnv>) => {
    const workspace = await ownWorkspace(
      drizzle(c.env.DB),
      c.req.param("workspaceId") ?? "",
      c.var.auth.user.id,
    );
    if (!workspace) {
      throw new HTTPException(404, { message: "There is no such workspace" });
    }
    return workspace;
  };

  /** The ID of the image in the path. */
  const mediaIdOf = (c: Context<AppEnv>) => {
    const id = idSchema.safeParse(c.req.param("mediaId"));
    if (!id.success) {
      throw new HTTPException(404, { message: "There is no such image" });
    }
    return id.data;
  };

  /**
   * Counts a request of an upload for whoever makes it, and refuses the
   * one that is over what a person may make in a minute. One statement,
   * so that two requests at once are both counted.
   */
  const counted = async (c: Context<AppEnv>) => {
    const minute = Math.floor(now().getTime() / minuteMs) * minuteMs;
    const [use] = await drizzle(c.env.DB)
      .insert(uploadUses)
      .values({ userId: c.var.auth.user.id, windowStart: minute, count: 1 })
      .onConflictDoUpdate({
        target: uploadUses.userId,
        set: {
          count: sql`case when ${uploadUses.windowStart} = excluded.window_start then ${uploadUses.count} + 1 else 1 end`,
          windowStart: sql`excluded.window_start`,
        },
      })
      .returning({ count: uploadUses.count });
    if ((use?.count ?? 0) > uploadRequestsPerMinute) {
      throw new HTTPException(429, {
        message:
          "pigy was sent more of images than it takes in a minute. The upload goes on in a moment.",
      });
    }
  };

  /** The upload of the image in the path, which has to be under way. */
  const uploadOf = async (
    c: Context<AppEnv>,
    workspace: WorkspaceIdentity,
    mediaId: string,
  ) => {
    const found = await mediaUploadOf(c.env.WORKSPACE, workspace, mediaId);
    // The row may be on its way still: the client asks again.
    if (!found) {
      throw new HTTPException(404, { message: "There is no such image" });
    }
    if (found.upload.status !== "uploading") {
      throw new HTTPException(409, {
        message: "This image is not being uploaded",
      });
    }
    return found;
  };

  const stateOf = (upload: MediaUpload) =>
    uploadStateSchema.parse({
      chunkBytes: uploadChunkBytes,
      received: upload.parts.map(({ partNumber }) => partNumber),
    });

  app.post(
    "/workspaces/:workspaceId/media/:mediaId/upload",
    signedIn,
    async (c) => {
      const workspace = await workspaceOf(c);
      const mediaId = mediaIdOf(c);
      await counted(c);
      const { upload, held } = await uploadOf(c, workspace, mediaId);
      if (upload.uploadId !== null) return c.json(stateOf(upload));
      // `held` counts this image too.
      if (held > maxWorkspaceMediaBytes) {
        const full =
          "The workspace holds as many images as it can. Delete drafts with images that you no longer need, or wait: pigy lets go of the images of a post 30 days after it was sent.";
        await finishUpload(c.env.WORKSPACE, workspace, mediaId, {
          error: full,
        });
        throw new HTTPException(413, { message: full });
      }
      const keys = mediaKeys(workspace.id, mediaId);
      const begun = await c.env.MEDIA.createMultipartUpload(keys.upload);
      const kept = await beginUpload(
        c.env.WORKSPACE,
        workspace,
        mediaId,
        begun.uploadId,
      );
      // Another request has begun the upload meanwhile, or the image has
      // ended: this upload is nobody's.
      if (kept?.uploadId !== begun.uploadId) await begun.abort();
      if (kept?.status !== "uploading") {
        throw new HTTPException(409, {
          message: "This image is not being uploaded",
        });
      }
      return c.json(stateOf(kept));
    },
  );

  app.put(
    "/workspaces/:workspaceId/media/:mediaId/upload/:number",
    signedIn,
    async (c) => {
      const workspace = await workspaceOf(c);
      const mediaId = mediaIdOf(c);
      await counted(c);
      const { upload } = await uploadOf(c, workspace, mediaId);
      const number = Number(c.req.param("number"));
      if (
        upload.uploadId === null ||
        !Number.isInteger(number) ||
        number < 1 ||
        number > Math.min(maxUploadChunks, uploadChunks(upload.size))
      ) {
        throw new HTTPException(400, {
          message: "The upload has no such chunk",
        });
      }
      // A chunk is exactly the bytes of its place in the file, whose
      // length the row says. So the file that the chunks make has that
      // length, and no request is read beyond what a chunk holds.
      const { start, end } = uploadChunkRange(upload.size, number);
      const length = end - start;
      if (Number(c.req.header("Content-Length")) !== length) {
        throw new HTTPException(400, {
          message: `Chunk ${number} of this image is ${length} bytes long`,
        });
      }
      // One chunk in memory, 5 MiB at most: the bucket wants to know the
      // length of what it is given, and this is where it is checked.
      const bytes = await c.req.arrayBuffer();
      if (bytes.byteLength !== length) {
        throw new HTTPException(400, {
          message: `Chunk ${number} of this image is ${length} bytes long`,
        });
      }
      const part = await c.env.MEDIA.resumeMultipartUpload(
        mediaKeys(workspace.id, mediaId).upload,
        upload.uploadId,
      ).uploadPart(number, bytes);
      const kept = await uploadedPart(
        c.env.WORKSPACE,
        workspace,
        mediaId,
        upload.uploadId,
        { partNumber: part.partNumber, etag: part.etag },
      );
      if (!kept) {
        throw new HTTPException(409, {
          message: "This image is not being uploaded",
        });
      }
      return c.json(stateOf(kept));
    },
  );

  app.post(
    "/workspaces/:workspaceId/media/:mediaId/upload/complete",
    signedIn,
    async (c) => {
      const workspace = await workspaceOf(c);
      const mediaId = mediaIdOf(c);
      await counted(c);
      const found = await mediaUploadOf(c.env.WORKSPACE, workspace, mediaId);
      if (!found) {
        throw new HTTPException(404, { message: "There is no such image" });
      }
      const { upload } = found;
      // Completed before: the answer of that time was lost, and so may
      // have been what was to be deleted after it.
      const ended = (status: "ready" | "failed") => {
        c.executionCtx.waitUntil(
          forgetUpload(c.env.MEDIA, workspace.id, mediaId, status).catch(
            (error) => {
              console.error("An upload was not forgotten", loggable(error));
            },
          ),
        );
        return c.json(uploadCompleteSchema.parse({ status }));
      };
      if (upload.status !== "uploading") return ended(upload.status);
      const { uploadId } = upload;
      if (
        uploadId === null ||
        upload.parts.length !== uploadChunks(upload.size)
      ) {
        throw new HTTPException(409, {
          message: "Not every chunk of this image has arrived",
        });
      }
      // To its end also when the client leaves: the parts are put
      // together once, and nobody else would read the file. What the
      // bucket has of the upload is deleted only once the workspace has
      // been told how it ended: a try after a failure to tell it reads
      // the file again.
      const work = (async () => {
        const outcome = await takeIn(
          c.env.MEDIA,
          imagesTransformer(c.env.IMAGES),
          workspace.id,
          mediaId,
          { ...upload, uploadId },
        );
        const told = await finishUpload(
          c.env.WORKSPACE,
          workspace,
          mediaId,
          outcome,
          // An image has one upload, and it ends once.
          `upload/${mediaId}`,
        );
        const status = told.ok && "facts" in outcome ? "ready" : "failed";
        await forgetUpload(c.env.MEDIA, workspace.id, mediaId, status);
        return status;
      })();
      c.executionCtx.waitUntil(
        work.catch((error) => {
          console.error("An image was not taken in", loggable(error));
        }),
      );
      try {
        return c.json(uploadCompleteSchema.parse({ status: await work }));
      } catch (error) {
        // A completion at the same time as this one has ended the upload
        // meanwhile: this one says how.
        const now = await mediaUploadOf(c.env.WORKSPACE, workspace, mediaId);
        if (now && now.upload.status !== "uploading") {
          return ended(now.upload.status);
        }
        throw error;
      }
    },
  );

  app.get(
    "/workspaces/:workspaceId/media/:mediaId/:file{original|thumbnail}",
    signedIn,
    async (c) => {
      const workspace = await workspaceOf(c);
      const keys = mediaKeys(workspace.id, mediaIdOf(c));
      const file = await c.env.MEDIA.get(
        c.req.param("file") === "original" ? keys.original : keys.thumbnail,
      );
      if (!file) {
        throw new HTTPException(404, { message: "There is no such image" });
      }
      return new Response(file.body, { headers: imageHeaders(file, "image") });
    },
  );

  // For a network that fetches an image of a post: no session, and the
  // one image that the link was signed for. Whatever is wrong with a
  // link, the answer is the same.
  app.get(`${mediaLinkPath.slice("/api".length)}/*`, async (c) => {
    const url = new URL(c.req.url);
    const links = mediaLinksWith(
      c.env,
      isLocal(url.origin) ? developmentCredentialKeys : undefined,
    );
    const key = await links?.check(url, now());
    const file = key === undefined ? null : await c.env.MEDIA.get(key);
    if (!file) {
      throw new HTTPException(404, { message: "There is nothing here" });
    }
    const headers = imageHeaders(file, "image");
    // Fetched by a network, from another origin.
    headers.delete("Cross-Origin-Resource-Policy");
    return new Response(file.body, { headers });
  });

  return app;
}
