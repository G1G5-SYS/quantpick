/* SEA 单文件注入(Node 官方 Single Executable Application, 零依赖)
 * 原理: 在 exe 末尾追加 fuse 标记 + 8字节 blob 偏移 + SEA blob;
 *       Node 运行时扫描整个文件定位 fuse 并加载 blob。
 * 用法: node inject-sea.js <exe源> <sea-blob> <输出exe>
 * 注意: 注入会使 exe 的数字签名失效(SEA 固有特性, 与官方 postject 行为一致)。 */
'use strict';
const fs = require('fs');
const [, , exeSrc, blobPath, exeOut] = process.argv;
if (!exeSrc || !blobPath || !exeOut) { console.error('用法: node inject-sea.js <exe> <blob> <out>'); process.exit(2); }
const FUSE = Buffer.from('NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2');
const exeBuf = fs.readFileSync(exeSrc);
const blob = fs.readFileSync(blobPath);
// blob 起始位置(相对文件头): 原exe长度 + fuse长度 + 8字节偏移
const offset = BigInt(exeBuf.length + FUSE.length + 8);
const offBuf = Buffer.alloc(8);
offBuf.writeBigUInt64LE(offset);
const out = Buffer.concat([exeBuf, FUSE, offBuf, blob]);
fs.writeFileSync(exeOut, out);
console.log('SEA 注入完成: ' + exeOut + ' (' + (out.length / 1024).toFixed(0) + ' KB)');
console.log('  fuse 位置: ' + exeBuf.length + ' · blob 偏移: ' + offset + ' · blob 大小: ' + blob.length);
