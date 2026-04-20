import { defineConfig } from 'prisma/config';
import { config } from 'dotenv';

// Load .env so DATABASE_URL and DIRECT_URL are available
config();

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'npx tsx prisma/seed.ts',
  },
  datasource: {
    // Prisma v7: The CLI uses this URL for migrations, generate, and db push.
    // We use DIRECT_URL (port 5432) to bypass the pooler for these operations.
    url: process.env.DIRECT_URL || process.env.DATABASE_URL as string,
  },
});
