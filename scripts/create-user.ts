import { randomBytes } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { config as loadEnv } from "dotenv";

import { PrismaClient } from "../lib/generated/prisma/client";
import { hashPassword, PASSWORD_MIN_LENGTH } from "../lib/password";

/**
 * Create a user from the command line. This is how the first administrator
 * exists.
 *
 *   npm run user:create -- --name "Jane Doe" --username jane \
 *                          --email jane@example.com --role ADMIN
 *
 * With no `--password`, one is generated and printed once. That is the default
 * on purpose: a password typed on a command line lands in shell history and in
 * the process list, where every other account on the box can read it.
 *
 * Why a script and not a seed: `prisma db seed` is for data a fresh database
 * needs in order to be useful, and it gets run by people who are resetting
 * their development database. An administrator account is neither. There is
 * also deliberately no bootstrap email or password anywhere in the app or its
 * environment — an account that exists because the code says so is an account
 * every deployment of this code shares.
 *
 * Safe to run against production: it only ever inserts, and it refuses to
 * touch an existing username or email.
 */

// tsx does not load .env.local; the Prisma client below needs DATABASE_URL, so
// this must happen before one is constructed.
loadEnv({ path: [".env.local", ".env"], quiet: true });

interface Args {
  name?: string;
  username?: string;
  email?: string;
  role?: string;
  password?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!flag.startsWith("--")) continue;
    const key = flag.slice(2) as keyof Args;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) continue;
    args[key] = value;
    i += 1;
  }
  return args;
}

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  console.error(
    '  Usage: npm run user:create -- --name "Jane Doe" --username jane \\\n' +
      "                              --email jane@example.com --role ADMIN\n",
  );
  process.exit(1);
}

/** 18 bytes of base64url — ~24 characters, well past the minimum length. */
function generatePassword(): string {
  return randomBytes(18).toString("base64url");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const name = args.name?.trim() ?? "";
  const username = args.username?.trim().toLowerCase() ?? "";
  const email = args.email?.trim().toLowerCase() ?? "";
  const role = (args.role ?? "AGENT").toUpperCase();

  if (!name) fail("--name is required.");
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    fail("--username must be 3-32 characters: a-z, 0-9, dot, underscore, hyphen.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail("--email must be a valid address.");
  if (role !== "ADMIN" && role !== "AGENT") fail("--role must be ADMIN or AGENT.");

  const generated = args.password === undefined;
  const password = args.password ?? generatePassword();
  if (password.length < PASSWORD_MIN_LENGTH) {
    fail(`--password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    fail("DATABASE_URL is not set. In production, run this with the systemd EnvironmentFile.");
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  try {
    const clash = await prisma.user.findFirst({
      where: { OR: [{ username }, { email }] },
      select: { username: true, email: true },
    });
    if (clash) {
      // Never overwrite. An "upsert" here would silently reset a real person's
      // password because someone re-ran the bootstrap command.
      fail(
        clash.username === username
          ? `A user with the username "${username}" already exists.`
          : `A user with the email "${email}" already exists.`,
      );
    }

    const user = await prisma.user.create({
      data: { name, username, email, role, passwordHash: await hashPassword(password) },
      select: { id: true, name: true, username: true, email: true, role: true },
    });

    console.log(`\n  Created ${user.role} "${user.name}"`);
    console.log(`    username  ${user.username}`);
    console.log(`    email     ${user.email}`);
    if (generated) {
      console.log(`    password  ${password}`);
      console.log("\n  This password is shown once and is not stored anywhere in readable");
      console.log("  form. Hand it over, and have them change it if you add that later.\n");
    } else {
      console.log("\n  Password: the one you passed on the command line.\n");
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("\n  Could not create the user:\n");
  console.error(error);
  process.exit(1);
});
