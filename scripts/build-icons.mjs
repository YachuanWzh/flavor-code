#!/usr/bin/env node
import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';

// 图标母版为像素风 PNG（assets/icon-source.png），不再从 SVG 生成，
// 避免构建时覆盖手工确认的图标。
const SOURCE = 'assets/icon-source.png';

console.log(`Building icons from ${SOURCE}...`);

await Promise.all([
  sharp(SOURCE).resize(512, 512).png().toFile('assets/icon.png'),
  sharp(SOURCE).resize(256, 256).png().toFile('assets/icon-256.png'),
  sharp(SOURCE).resize(256, 256).png().toFile('assets/icon-preview.png'),
  sharp(SOURCE).resize(256, 256).png().toFile('extensions/vscode/media/flavor.png')
]);

console.log('✓ Generated assets/icon.png (512x512)');
console.log('✓ Generated assets/icon-256.png (256x256)');
console.log('✓ Generated assets/icon-preview.png (256x256)');
console.log('✓ Generated extensions/vscode/media/flavor.png (256x256)');

// 生成 Windows 用多尺寸 ICO（内嵌 PNG，Vista+ 有效），
// electron-builder 通过 package.json 的 "icon": "assets/icon" 使用 assets/icon.ico。
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = await Promise.all(
  sizes.map((size) => sharp(SOURCE).resize(size, size).png().toBuffer())
);

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: 1 = ICO
header.writeUInt16LE(pngs.length, 4);

const entries = [];
let offset = 6 + 16 * pngs.length;
pngs.forEach((png, index) => {
  const entry = Buffer.alloc(16);
  entry.writeUInt8(sizes[index] >= 256 ? 0 : sizes[index], 0); // width, 0 表示 256
  entry.writeUInt8(sizes[index] >= 256 ? 0 : sizes[index], 1); // height
  entry.writeUInt8(0, 2); // colorCount
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bitCount
  entry.writeUInt32LE(png.length, 8); // bytesInRes
  entry.writeUInt32LE(offset, 12); // imageOffset
  offset += png.length;
  entries.push(entry);
});

await writeFile('assets/icon.ico', Buffer.concat([header, ...entries, ...pngs]));
console.log(`✓ Generated assets/icon.ico (${sizes.join('/')}px)`);
