import { PrismaClient, ProposalStatus, Role } from '@prisma/client';

const prisma = new PrismaClient();

// Stellar public keys are 56 chars; pad readable placeholders to that length.
const wallet = (prefix: string): string => prefix.padEnd(56, 'A');

async function main(): Promise<void> {
  const admin = await prisma.user.upsert({
    where: { walletAddress: wallet('GADMIN') },
    update: {},
    create: {
      walletAddress: wallet('GADMIN'),
      email: 'admin@creon.test',
      displayName: 'Creon Admin',
      roles: [Role.ADMIN],
    },
  });

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
