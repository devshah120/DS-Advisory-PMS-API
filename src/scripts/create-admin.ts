/**
 * One-off script to create (or promote) a single ADMIN user.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register src/scripts/create-admin.ts
 *
 * The password can be overridden with ADMIN_PASSWORD; otherwise a default is
 * used and printed once so it can be changed after first login.
 */
import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const EMAIL = 'devshah120902@gmail.com';
const FIRST_NAME = 'Dev';
const LAST_NAME = 'Shah';

async function main() {
  const prisma = new PrismaClient();
  try {
    const plainPassword = process.env.ADMIN_PASSWORD ?? 'Admin@123';
    const password = await bcrypt.hash(plainPassword, 10);

    const user = await prisma.user.upsert({
      where: { email: EMAIL },
      update: { role: Role.ADMIN, active: true },
      create: {
        email: EMAIL,
        firstName: FIRST_NAME,
        lastName: LAST_NAME,
        password,
        role: Role.ADMIN,
        active: true,
      },
    });

    console.log(`Admin ready: ${user.email} (id: ${user.id}, role: ${user.role})`);
    if (!process.env.ADMIN_PASSWORD) {
      console.log(`Default password: ${plainPassword} — change it after first login.`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Failed to create admin:', err);
  process.exit(1);
});
