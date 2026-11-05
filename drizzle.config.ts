import { defineConfig } from 'drizzle-kit'
import 'dotenv/config'

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be set in .env')
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './db/schema/index.ts',
  out: './db/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  casing: 'snake_case',
  verbose: true,
  strict: true,
})
