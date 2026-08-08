#!/usr/bin/env node
import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';

// 图标母版为像素风透明底 PNG（assets/icon-transparent.png），不再从 SVG 生成，
// 避免构建时覆盖手工确认的图标。所有产物均为透明底。
const SOURCE = 'assets/icon-transparent.png';

console.log(`Building icons from ${SOURCE}...`);

// 透明底母版四周有空白，先裁剪到角色包围盒，再按 88% 占比居中放入方形透明画布，
// 避免图标里角色显得偏小
const TRIMMED = await sharp(SOURCE).trim().png().toBuffer();
const TRANSPARENT_BG = { r: 0, g: 0, b: 0, alpha: 0 };
const iconAt = (size) => {
  const inner = Math.round(size * 0.88);
  const pad = Math.floor((size - inner) / 2);
  return sharp(TRIMMED)
    .resize(inner, inner, { fit: 'contain', background: TRANSPARENT_BG })
    .extend({ top: pad, bottom: size - inner - pad, left: pad, right: size - inner - pad, background: TRANSPARENT_BG })
    .png();
};

await Promise.all([
  iconAt(512).toFile('assets/icon.png'),
  iconAt(256).toFile('assets/icon-256.png'),
  iconAt(256).toFile('assets/icon-preview.png'),
  iconAt(256).toFile('extensions/vscode/media/flavor.png')
]);

console.log('✓ Generated assets/icon.png (512x512)');
console.log('✓ Generated assets/icon-256.png (256x256)');
console.log('✓ Generated assets/icon-preview.png (256x256)');
console.log('✓ Generated extensions/vscode/media/flavor.png (256x256)');

// 生成 Windows 用多尺寸 ICO（内嵌 PNG，Vista+ 有效），
// electron-builder 通过 package.json 的 "icon": "assets/icon" 使用 assets/icon.ico。
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = await Promise.all(
  sizes.map((size) => iconAt(size).toBuffer())
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
