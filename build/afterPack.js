// afterPack: 打包后裁剪不必要的文件，缩小便携包体积
const fs = require('fs');
const path = require('path');

exports.default = async function (context) {
  const { appOutDir } = context;

  // 1. 裁剪语言包：只保留中文和英文
  const keepLocales = new Set(['zh-CN.pak', 'zh-TW.pak', 'en-US.pak', 'en-GB.pak']);
  const localesDir = path.join(appOutDir, 'locales');
  if (fs.existsSync(localesDir)) {
    let removed = 0;
    let savedBytes = 0;
    for (const file of fs.readdirSync(localesDir)) {
      if (!keepLocales.has(file)) {
        const p = path.join(localesDir, file);
        const stat = fs.statSync(p);
        savedBytes += stat.size;
        fs.unlinkSync(p);
        removed++;
      }
    }
    console.log(`[afterPack] 裁剪 ${removed} 个语言包，节省 ${(savedBytes / 1024 / 1024).toFixed(1)}MB`);
  }

  // 2. 移除 SwiftShader (WebGPU 软渲染) — 本应用不使用 WebGPU
  const removeDlls = [
    'vk_swiftshader.dll',
    'vulkan-1.dll',
  ];
  for (const dll of removeDlls) {
    const p = path.join(appOutDir, dll);
    if (fs.existsSync(p)) {
      const size = fs.statSync(p).size;
      fs.unlinkSync(p);
      console.log(`[afterPack] 移除 ${dll}，节省 ${(size / 1024 / 1024).toFixed(1)}MB`);
    }
  }
};
