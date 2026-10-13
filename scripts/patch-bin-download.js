/**
 * patch-bin-download.js
 * ─────────────────────────────────────────────────────────────
 * 解决 Windows 上 electron-builder 打包失败的经典问题：
 * winCodeSign-2.6.0.7z 内含 macOS 符号链接（darwin/*.dylib），
 * Windows 非管理员无 SeCreateSymbolicLinkPrivilege 权限，7z 解压
 * 报 exit status 2，导致 portable/nsis 打包无限重试失败。
 *
 * 方案：给 app-builder-lib/out/binDownload.js 的 doGetBin 打补丁，
 * 遇到 winCodeSign 时直接复用本地缓存中已手动补全的目录
 * （rcedit-x64.exe + signtool.exe 齐全，占位 dylib 已补齐）。
 *
 * 缓存目录准备（一次性，已完成）：
 *   用 7za 手动解压 Cache/winCodeSign/*.7z 并 touch 两个 dylib 占位。
 *
 * 本脚本幂等，重复执行安全。由 package.json postinstall 自动调用。
 */
const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, '..', 'node_modules', 'app-builder-lib', 'out', 'binDownload.js');

if (!fs.existsSync(target)) {
  console.log('[patch] app-builder-lib 未安装，跳过补丁');
  process.exit(0);
}

let src = fs.readFileSync(target, 'utf8');

if (src.includes('winCodeSign cache workaround')) {
  console.log('[patch] binDownload.js 已打过补丁，跳过');
  process.exit(0);
}

const anchor = 'function doGetBin(name, url, checksum) {';
if (!src.includes(anchor)) {
  console.error('[patch] 找不到 doGetBin 锚点，补丁失败（electron-builder 版本不兼容？）');
  process.exit(1);
}

const patch = `function doGetBin(name, url, checksum) {
    // >>> winCodeSign cache workaround (patch-bin-download.js)
    // Windows 无管理员权限无法解压压缩包内的 macOS 符号链接，
    // 直接复用本地已补全的 winCodeSign 缓存目录。
    if (name === "winCodeSign") {
        try {
            const fsSync = require("fs");
            const pathMod = require("path");
            const osMod = require("os");
            const cacheRoot = process.env.ELECTRON_BUILDER_CACHE ||
                pathMod.join(osMod.homedir(), "AppData", "Local", "electron-builder", "Cache");
            const wcDir = pathMod.join(cacheRoot, "winCodeSign");
            if (fsSync.existsSync(wcDir)) {
                for (const d of fsSync.readdirSync(wcDir)) {
                    const p = pathMod.join(wcDir, d);
                    if (fsSync.existsSync(pathMod.join(p, "rcedit-x64.exe")) &&
                        fsSync.existsSync(pathMod.join(p, "windows-10", "x64", "signtool.exe"))) {
                        return Promise.resolve(p);
                    }
                }
            }
        }
        catch (e) { /* 回落到正常下载流程 */ }
    }
    // <<< end workaround
`;

src = src.replace(anchor, patch);
fs.writeFileSync(target, src, 'utf8');
console.log('[patch] binDownload.js 补丁完成（winCodeSign 缓存复用）');
