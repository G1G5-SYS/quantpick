/* 桌面版构建: 剥离 node.exe 数字签名(SEA 注入前必须, 否则系统拒绝运行被篡改的 exe)
 * 原理: 解析 PE → 找到 OptionalHeader 的 Security Directory(证书表) → 截掉文件末尾证书块并清零目录项
 * 用法: node strip-sign.js <node.exe> <输出无签名exe>
 * 安全: 仅操作副本, 不修改原 node.exe */
'use strict';
const fs = require('fs');
const [, , src, out] = process.argv;
if (!src || !out) { console.error('用法: node strip-sign.js <exe> <out>'); process.exit(2); }
const buf = fs.readFileSync(src);
// DOS header → e_lfanew
const peOff = buf.readUInt32LE(0x3c);
if (buf.toString('ascii', peOff, peOff + 4) !== 'PE\u0000\u0000') { console.error('不是有效 PE 文件'); process.exit(2); }
const coff = peOff + 4;
const optMagic = buf.readUInt16LE(coff + 16);
const numSections = buf.readUInt16LE(coff + 2);
// Optional Header 起始 = COFF 头(20字节)之后; DataDirectory 在 Windows 字段(96/112字节)之后
const optStart = coff + 20;
const ddOffset = optMagic === 0x20b ? optStart + 112 : optStart + 96;
// Security Directory = 第 5 项(下标 4): RVA(文件偏移) + Size
const secIdx = 4;
const secRva = buf.readUInt32LE(ddOffset + secIdx * 8);
const secSize = buf.readUInt32LE(ddOffset + secIdx * 8 + 4);
console.log('Security Directory: RVA=' + secRva + ' Size=' + secSize + ' 文件长度=' + buf.length);
let stripped = buf;
if (secRva && secSize && secRva + secSize <= buf.length) {
  // 证书块位于文件末尾(通常), 截断到证书起始
  if (secRva + secSize >= buf.length - 0x200) {
    stripped = buf.slice(0, secRva);
    console.log('已截断证书块, 新长度=' + stripped.length);
  } else {
    console.log('证书不在文件末尾(可能内嵌), 保守处理: 仅清零目录项');
  }
  // 清零 Security Directory 项(写入副本)
  stripped = Buffer.from(stripped);
  stripped.writeUInt32LE(0, ddOffset + secIdx * 8);
  stripped.writeUInt32LE(0, ddOffset + secIdx * 8 + 4);
}
fs.writeFileSync(out, stripped);
console.log('剥离完成: ' + out + ' (' + (stripped.length / 1024).toFixed(0) + ' KB, sections=' + numSections + ')');
