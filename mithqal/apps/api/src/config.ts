export interface Config {
  /** Owner/migration connection (DDL). */
  migrationUrl: string;
  /** Runtime connection as the non-superuser `mithqal_app` role (RLS enforced). */
  appUrl: string;
  jwtSecret: string;
  port: number;
  /** "mock" accepts every e-invoice locally; "sandbox"/"production" call ZATCA. */
  zatcaMode: "mock" | "sandbox" | "simulation" | "production";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const db = env.DB_NAME ?? "mithqal";
  const host = env.DB_HOST ?? "localhost";
  const cfg: Config = {
    migrationUrl: env.MIGRATION_DATABASE_URL ?? `postgres://mithqal:mithqal@${host}:5432/${db}`,
    appUrl: env.DATABASE_URL ?? `postgres://mithqal_app:mithqal_app@${host}:5432/${db}`,
    jwtSecret: env.JWT_SECRET ?? "dev-only-secret-change-me-dev-only-secret",
    port: Number(env.PORT ?? 4000),
    zatcaMode: (env.ZATCA_MODE as Config["zatcaMode"]) ?? "mock",
  };
  if (env.NODE_ENV === "production" && cfg.jwtSecret.startsWith("dev-only")) {
    throw new Error("JWT_SECRET must be set in production");
  }
  return cfg;
}
