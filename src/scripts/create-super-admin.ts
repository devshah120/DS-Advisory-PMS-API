/**
 * Creates (or promotes) the firm's SUPER_ADMIN.
 *
 * SUPER_ADMIN is deliberately not assignable from the Users screen — the tier
 * that can create and delete other logins is provisioned out-of-band, so a
 * stolen session cannot quietly mint a second permanent one. This script is
 * that out-of-band path.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register src/scripts/create-super-admin.ts
 *   SUPER_ADMIN_EMAIL=someone@example.com npx ts-node ... (to target another account)
 *
 * Idempotent: run it again to re-promote an existing account. An existing
 * user's password is left alone unless SUPER_ADMIN_PASSWORD is set, so
 * re-running never silently resets a working login.
 */
import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const EMAIL = (process.env.SUPER_ADMIN_EMAIL ?? 'dev@dsadvisory.com')
  .trim()
  .toLowerCase();
const FIRST_NAME = process.env.SUPER_ADMIN_FIRST_NAME ?? 'Dev';
const LAST_NAME = process.env.SUPER_ADMIN_LAST_NAME ?? 'Shah';

async function main() {
  const prisma = new PrismaClient();
  try {
    const existing = await prisma.user.findUnique({ where: { email: EMAIL } });

    // Only hash a password when one is actually going to be written: for a new
    // account (which needs one) or when explicitly overriding an existing one.
    const overridePassword = process.env.SUPER_ADMIN_PASSWORD;
    const plainPassword = overridePassword ?? 'Admin@123';

    if (existing) {
      const user = await prisma.user.update({
        where: { email: EMAIL },
        data: {
          role: Role.SUPER_ADMIN,
          active: true,
          ...(overridePassword && {
            password: await bcrypt.hash(overridePassword, 10),
          }),
        },
      });
      console.log(`Promoted to Super Admin: ${user.email} (id: ${user.id})`);
      if (overridePassword) console.log('Password was reset from SUPER_ADMIN_PASSWORD.');
      else console.log('Existing password left unchanged.');
      return;
    }

    const user = await prisma.user.create({
      data: {
        email: EMAIL,
        firstName: FIRST_NAME,
        lastName: LAST_NAME,
        password: await bcrypt.hash(plainPassword, 10),
        role: Role.SUPER_ADMIN,
        active: true,
      },
    });

    console.log(`Super Admin created: ${user.email} (id: ${user.id})`);
    if (!overridePassword) {
      console.log(`Default password: ${plainPassword} — change it after first login.`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Failed to create super admin:', err);
  process.exit(1);
});
