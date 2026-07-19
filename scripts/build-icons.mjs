#!/usr/bin/env node
import sharp from 'sharp';

console.log('Building icons from SVG...');

await Promise.all([
  sharp('assets/icon.svg').resize(512, 512).png().toFile('assets/icon.png'),
  sharp('assets/icon.svg').resize(256, 256).png().toFile('assets/icon-256.png')
]);

console.log('✓ Generated assets/icon.png (512x512)');
console.log('✓ Generated assets/icon-256.png (256x256)');
