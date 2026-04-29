import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const dir = process.argv[2];
if (!dir) {
  console.error("Usage: npx tsx scripts/compress-images.ts <images-dir>");
  process.exit(1);
}

async function compressDir(dirPath: string) {
  const files = fs.readdirSync(dirPath);
  let processed = 0;
  let saved = 0;
  const total = files.filter((f) => !f.endsWith(".webp")).length;

  for (const file of files) {
    const filePath = path.join(dirPath, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      await compressDir(filePath);
      continue;
    }

    // Skip already-compressed webp files
    if (file.endsWith(".webp")) continue;

    const ext = path.extname(file).toLowerCase();
    if (![".jpg", ".jpeg", ".png", ".gif", ".bmp", ".tiff"].includes(ext)) continue;

    const outPath = filePath.replace(/\.[^.]+$/, ".webp");
    const originalSize = stat.size;

    try {
      await sharp(filePath).webp({ quality: 80 }).toFile(outPath);
      const newSize = fs.statSync(outPath).size;
      saved += originalSize - newSize;
      // Remove original after successful compression
      fs.unlinkSync(filePath);
      processed++;
      if (processed % 100 === 0) {
        console.log(`${processed}/${total} — saved ${(saved / 1024 / 1024).toFixed(0)} MB so far`);
      }
    } catch {
      // Skip files sharp can't handle
      processed++;
    }
  }

  return { processed, saved };
}

console.log(`Compressing images in: ${dir}`);
const start = Date.now();
compressDir(dir).then(({ processed, saved }) => {
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`Done. ${processed} images compressed. Saved ${(saved / 1024 / 1024 / 1024).toFixed(1)} GB in ${elapsed}s`);
});
