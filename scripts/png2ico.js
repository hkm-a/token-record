'use strict';

// 将 build/icon.png 封装为 build/icon.ico（PNG-in-ICO，256×256，Windows Vista+ 支持）。
// ICO 结构：6 字节目录头 + 16 字节目录项 + 原始 PNG 数据。

const fs = require('fs');
const path = require('path');

const buildDir = path.join(__dirname, '..', 'build');
const png = fs.readFileSync(path.join(buildDir, 'icon.png'));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // 保留
header.writeUInt16LE(1, 2); // 类型：1=图标
header.writeUInt16LE(1, 4); // 图像数量

const entry = Buffer.alloc(16);
entry.writeUInt8(0, 0); // 宽度：0 表示 256
entry.writeUInt8(0, 1); // 高度：0 表示 256
entry.writeUInt8(0, 2); // 调色板颜色数
entry.writeUInt8(0, 3); // 保留
entry.writeUInt16LE(1, 4); // 颜色平面
entry.writeUInt16LE(32, 6); // 位深
entry.writeUInt32LE(png.length, 8); // PNG 数据字节数
entry.writeUInt32LE(22, 12); // 数据偏移（6+16）

const ico = Buffer.concat([header, entry, png]);
fs.writeFileSync(path.join(buildDir, 'icon.ico'), ico);
console.log('已生成 ' + path.join(buildDir, 'icon.ico') + '（' + ico.length + ' 字节）');
