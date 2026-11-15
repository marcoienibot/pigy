/**
 * What a build of the web app says about itself to its service worker. The
 * build writes it into the worker: see service-worker-plugin.ts.
 */
export type Build = {
  /** Names the build: a hash of its files. */
  version: string;
  /**
   * The path of every file of the web app, as the server has it: `/` for
   * the app shell, which is index.html.
   */
  files: readonly string[];
  /** `assets.run_worker_first` of apps/worker/wrangler.jsonc. */
  workerFirst: readonly string[];
};
