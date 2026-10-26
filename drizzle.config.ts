import { existsSync } from "node:fs";
import { defineConfig } from "drizzle-kit";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

const user = process.env.POSTGRES_USER ?? "mybot";
const password = process.env.POSTGRES_PASSWORD ?? "";
const port = process.env.POSTGRES_PORT ?? "5432";
const database = process.env.POSTGRES_DB ?? "mybot";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${encodeURIComponent(database)}`,
  },
  verbose: true,
  strict: true,
});
