// The Worker is built by Vite: by apps/web/vite.config.ts, and by Vitest for
// the tests. Both replace `import.meta.env.MODE` with the mode of the build:
// "production" for `vite build`, "development" for `vite dev`, "test" under
// Vitest, and otherwise whatever `--mode` says.
interface ImportMetaEnv {
  readonly MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
