import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createPrismaClient() {
  // Prisma v7 uses the "client" engine type, which requires a driver adapter.
  // PrismaPg connects to Supabase's PostgreSQL via the DATABASE_URL pooler URL.
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
  });

  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });
}

/**
 * Global Prisma Client singleton (Prisma v7 + Supabase PostgreSQL).
 * Re-uses the same instance in development to avoid exhausting connections
 * during Next.js hot-reloading.
 */
export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
