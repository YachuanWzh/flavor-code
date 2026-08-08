#!/usr/bin/env node
// 从 assets/icon-source.png 抠出透明背景版 icon：
// 两段式魔棒——先从四边以「外框灰」为参考色连通抠除外圈，
// 再以暴露出的深色区域均值为参考色抠掉内部深灰圆角底（含渐变内阴影与水印）。
// 角色黑色描边与参考色距离足够大，不会被误抠。输出 assets/icon-transparent.png。
import sharp from 'sharp';

const SOURCE = 'assets/icon-source.png';
const OUTPUT = 'assets/icon-transparent.png';
const TOL_OUTER = 90; // 外圈灰色系容差（欧氏距离）
const TOL_INNER = 80; // 内部深灰容差，黑色描边(~104)被挡在外面

const { data, info } = await sharp(SOURCE)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const { width, height } = info;

const rgb = (p) => [data[p * 4], data[p * 4 + 1], data[p * 4 + 2]];
const dist = (a, b) =>
  Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);

const removed = new Uint8Array(width * height);

function flood(seeds, ref, tol) {
  const queue = [];
  const tryPush = (p) => {
    if (!removed[p] && dist(rgb(p), ref) <= tol) {
      removed[p] = 1;
      queue.push(p);
    }
  };
  seeds.forEach(tryPush);
  while (queue.length) {
    const p = queue.pop();
    const x = p % width;
    const y = (p - x) / width;
    if (x + 1 < width) tryPush(p + 1);
    if (x > 0) tryPush(p - 1);
    if (y + 1 < height) tryPush(p + width);
    if (y > 0) tryPush(p - width);
  }
}

// Pass A: 四边种子，参考色取边框像素均值
let sr = 0, sg = 0, sb = 0, n = 0;
for (let x = 0; x < width; x++) {
  for (const y of [0, height - 1]) { const c = rgb(y * width + x); sr += c[0]; sg += c[1]; sb += c[2]; n++; }
}
for (let y = 0; y < height; y++) {
  for (const x of [0, width - 1]) { const c = rgb(y * width + x); sr += c[0]; sg += c[1]; sb += c[2]; n++; }
}
const refOuter = [sr / n, sg / n, sb / n];
const borderSeeds = [];
for (let x = 0; x < width; x++) borderSeeds.push(x, (height - 1) * width + x);
for (let y = 0; y < height; y++) borderSeeds.push(y * width, y * width + width - 1);
flood(borderSeeds, refOuter, TOL_OUTER);

// Pass B: 取 Pass A 区域邻域中偏暗的像素作为内圈种子，参考色为其均值
const innerSeeds = [];
let ir = 0, ig = 0, ib = 0, m = 0;
for (let y = 1; y < height - 1; y++) {
  for (let x = 1; x < width - 1; x++) {
    const p = y * width + x;
    if (removed[p]) continue;
    const nearRemoved =
      removed[p - 1] || removed[p + 1] || removed[p - width] || removed[p + width];
    if (!nearRemoved) continue;
    const c = rgb(p);
    const lum = (c[0] + c[1] + c[2]) / 3;
    if (lum < 110) {
      innerSeeds.push(p);
      ir += c[0]; ig += c[1]; ib += c[2]; m++;
    }
  }
}
if (m > 0) {
  const refInner = [ir / m, ig / m, ib / m];
  flood(innerSeeds, refInner, TOL_INNER);
}

let count = 0;
for (let p = 0; p < width * height; p++) {
  if (removed[p]) {
    data[p * 4 + 3] = 0;
    count++;
  }
}

// 清理孤立碎片（如水印残留）：保留面积较大的连通块，
// 以及位于主体包围盒内的小块（徽章 </> 、叶片高光等内部细节）
const opaque = new Uint8Array(width * height);
for (let p = 0; p < width * height; p++) opaque[p] = data[p * 4 + 3] > 0 ? 1 : 0;
const seen = new Uint8Array(width * height);
const components = [];
for (let s = 0; s < width * height; s++) {
  if (!opaque[s] || seen[s]) continue;
  const comp = [];
  const stack = [s];
  seen[s] = 1;
  while (stack.length) {
    const p = stack.pop();
    comp.push(p);
    const x = p % width;
    const y = (p - x) / width;
    const neighbors = [];
    if (x + 1 < width) neighbors.push(p + 1);
    if (x > 0) neighbors.push(p - 1);
    if (y + 1 < height) neighbors.push(p + width);
    if (y > 0) neighbors.push(p - width);
    for (const q of neighbors) {
      if (opaque[q] && !seen[q]) {
        seen[q] = 1;
        stack.push(q);
      }
    }
  }
  let minX = width, minY = height, maxX = 0, maxY = 0;
  for (const p of comp) {
    const x = p % width;
    const y = (p - x) / width;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  components.push({ comp, minX, minY, maxX, maxY });
}
const main = components.reduce((a, b) => (a.comp.length >= b.comp.length ? a : b));
const kept = new Set();
for (const c of components) {
  const inMainBox =
    c.minX >= main.minX && c.maxX <= main.maxX &&
    c.minY >= main.minY && c.maxY <= main.maxY;
  if (c.comp.length >= 1500 || inMainBox) {
    for (const p of c.comp) kept.add(p);
  }
}
let dropped = 0;
for (let p = 0; p < width * height; p++) {
  if (opaque[p] && !kept.has(p)) {
    data[p * 4 + 3] = 0;
    dropped++;
  }
}

await sharp(data, { raw: { width, height, channels: 4 } })
  .png()
  .toFile(OUTPUT);

console.log(`✓ ${OUTPUT} (透明像素: ${count}/${width * height} = ${(count / (width * height) * 100).toFixed(1)}%, 清理碎片 ${dropped}px)`);
