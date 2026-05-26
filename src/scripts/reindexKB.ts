// tsx src/scripts/reindexKB.ts
// Walks kb/ for .md files, chunks them, embeds via Voyage AI, and upserts into KBChunk.

import 'dotenv/config';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { embed } from '../shared/voyage.js';

const KB_DIR = join(process.cwd(), 'kb');
const TARGET_CHARS = 2400; // ~600 tokens at ~4 chars/token
const OVERLAP_CHARS = 400; // ~100 tokens
const EMBED_BATCH_SIZE = 20;
const PACING_MS = 21_000; // Voyage free tier: 3 RPM without billing method

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// --- File walking ---

const walkMdFiles = (dir: string): string[] => {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...walkMdFiles(full));
    } else if (entry.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
};

// --- Chunking ---
// Split on double newlines, accumulate paragraphs up to TARGET_CHARS,
// then slide back OVERLAP_CHARS before starting the next window.

const chunkDocument = (content: string): string[] => {
  const paragraphs = content.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length === 0) return [];

  const chunks: string[] = [];
  let i = 0;

  while (i < paragraphs.length) {
    const bucket: string[] = [];
    let chars = 0;
    let j = i;

    while (j < paragraphs.length && chars < TARGET_CHARS) {
      bucket.push(paragraphs[j]);
      chars += paragraphs[j].length + 2; // +2 for '\n\n'
      j++;
    }

    chunks.push(bucket.join('\n\n'));

    if (j >= paragraphs.length) break; // consumed all remaining paragraphs

    // Find overlap start: walk backward from j until we've accumulated ~OVERLAP_CHARS.
    let overlap = 0;
    let nextStart = j;
    while (nextStart > i + 1) {
      const para = paragraphs[nextStart - 1];
      if (overlap + para.length + 2 > OVERLAP_CHARS) break;
      overlap += para.length + 2;
      nextStart--;
    }
    // Always advance by at least one paragraph to guarantee termination.
    i = Math.max(nextStart, i + 1);
  }

  return chunks;
};

// --- Main ---

const files = walkMdFiles(KB_DIR);
if (files.length === 0) {
  console.log(JSON.stringify({ status: 'no-md-files-found' }));
  await prisma.$disconnect();
  throw new Error('No .md files found in kb/');
}

let totalChunks = 0;
let totalFiles = 0;
let isFirstEmbed = true;

for (const absPath of files) {
  const docPath = relative(process.cwd(), absPath); // e.g. "kb/product/listing-tiers.md"
  const content = readFileSync(absPath, 'utf-8');
  const chunks = chunkDocument(content);

  if (chunks.length === 0) {
    console.log(JSON.stringify({ skipped: docPath, reason: 'empty' }));
    continue;
  }

  // Delete stale chunks for this document before reinserting.
  await prisma.kBChunk.deleteMany({ where: { docPath } });

  // Embed in batches of EMBED_BATCH_SIZE.
  for (let b = 0; b < chunks.length; b += EMBED_BATCH_SIZE) {
    if (!isFirstEmbed) await sleep(PACING_MS);
    isFirstEmbed = false;

    const batchChunks = chunks.slice(b, b + EMBED_BATCH_SIZE);
    const vectors = await embed(batchChunks);

    for (let k = 0; k < batchChunks.length; k++) {
      const idx = b + k;
      const content = batchChunks[k];
      const vec = vectors[k];

      await prisma.$executeRawUnsafe(
        `INSERT INTO "KBChunk" ("id","docPath","chunkIdx","content","embedding","metadata")
         VALUES ($1,$2,$3,$4,$5::vector,$6::jsonb)`,
        crypto.randomUUID(),
        docPath,
        idx,
        content,
        JSON.stringify(vec),
        JSON.stringify({}),
      );
    }
  }

  console.log(JSON.stringify({ indexed: docPath, chunks: chunks.length }));
  totalChunks += chunks.length;
  totalFiles += 1;
}

await prisma.auditLog.create({
  data: {
    action: 'cron.success',
    entity: 'reindexKB',
    meta: { files: totalFiles, chunks: totalChunks },
  },
});

console.log(JSON.stringify({ status: 'done', files: totalFiles, chunks: totalChunks }));

await prisma.$disconnect();
