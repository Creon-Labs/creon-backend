import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, ProposalStatus, Role } from '../generated/prisma/client';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

// Stellar public keys are 56 chars; pad readable placeholders to that length.
const wallet = (prefix: string): string => prefix.padEnd(56, 'A');

/** Real admin wallet (can sign SEP-53 challenges). Not self-registerable. */
const ADMIN_WALLET =
  'GAEASS4NZTN37AUAYA4HOEHD3A6ZW5JINYJJLWUN6VV4J6CQ7UVV4CYB';
const ADMIN_EMAIL = 'admin@creon.test';

async function ensureAdmin(): Promise<{ id: string }> {
  const legacyWallet = wallet('GADMIN');
  const byWallet = await prisma.user.findUnique({
    where: { walletAddress: ADMIN_WALLET },
  });
  if (byWallet) {
    return prisma.user.update({
      where: { id: byWallet.id },
      data: {
        roles: [Role.ADMIN],
        email: ADMIN_EMAIL,
        displayName: 'Creon Admin',
      },
    });
  }

  // Migrate placeholder seed admin (GADMIN… + admin@creon.test) if present.
  const byLegacy =
    (await prisma.user.findUnique({ where: { walletAddress: legacyWallet } })) ??
    (await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } }));
  if (byLegacy) {
    return prisma.user.update({
      where: { id: byLegacy.id },
      data: {
        walletAddress: ADMIN_WALLET,
        roles: [Role.ADMIN],
        email: ADMIN_EMAIL,
        displayName: 'Creon Admin',
      },
    });
  }

  return prisma.user.create({
    data: {
      walletAddress: ADMIN_WALLET,
      email: ADMIN_EMAIL,
      displayName: 'Creon Admin',
      roles: [Role.ADMIN],
    },
  });
}

async function main(): Promise<void> {
  const admin = await ensureAdmin();

  const entrepreneur = await prisma.user.upsert({
    where: { walletAddress: wallet('GENTRE') },
    update: {},
    create: {
      walletAddress: wallet('GENTRE'),
      email: 'umkm@creon.test',
      displayName: 'Warung Kopi Nusantara',
      roles: [Role.ENTREPRENEUR],
    },
  });

  const investor = await prisma.user.upsert({
    where: { walletAddress: wallet('GINVES') },
    update: {},
    create: {
      walletAddress: wallet('GINVES'),
      email: 'investor@creon.test',
      displayName: 'Investor Satu',
      roles: [Role.INVESTOR],
    },
  });

  const existingProposal = await prisma.proposal.findFirst({
    where: {
      entrepreneurId: entrepreneur.id,
      businessName: 'Warung Kopi Nusantara',
    },
  });

  if (!existingProposal) {
    await prisma.proposal.create({
      data: {
        entrepreneurId: entrepreneur.id,
        businessName: 'Warung Kopi Nusantara',
        businessDescription:
          'Ekspansi gerai kopi UMKM di Yogyakarta dengan modal urun dana.',
        category: 'Kuliner',
        location: 'Yogyakarta',
        requestedAmount: '10000.0000000',
        fundingDurationDays: 30,
        lockPeriodDays: 180,
        status: ProposalStatus.DRAFT,
      },
    });
  }

  console.log('Seed complete:', {
    admin: admin.id,
    entrepreneur: entrepreneur.id,
    investor: investor.id,
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
