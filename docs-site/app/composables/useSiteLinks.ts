// Nuxt-only: kept out of app/utils/site.ts, which nuxt.config.ts imports.

/** The public repository: app.config `github.url`, the same source as the docs header's icon. */
export function useRepoUrl(): string | undefined {
  const github = useAppConfig().github;
  return (github && github.url) || undefined;
}

/** The dashboard's sign-in and sign-up, from runtime config. */
export function useAppLinks() {
  const app = useRuntimeConfig().public.appUrl.replace(/\/+$/, "");
  return { signIn: `${app}/login`, signUp: `${app}/signup` };
}
