// Append ID3v1 blocks to notag.mp3: v1.mp3 (Latin-1) and v1-gbk.mp3 (GBK bytes, as Chinese rippers write them).
const fs = require('fs');
function v1(t, a) { const b = Buffer.alloc(128); b.write('TAG', 0, 'latin1'); t.copy(b, 3, 0, 30); a.copy(b, 33, 0, 30); b[127] = 255; return b; }
const base = fs.readFileSync('notag.mp3');
fs.writeFileSync('v1.mp3', Buffer.concat([base, v1(Buffer.from('Only V1', 'latin1'), Buffer.from('Old Artist', 'latin1'))]));
fs.writeFileSync('v1-gbk.mp3', Buffer.concat([base, v1(Buffer.from([0xc6, 0xdf, 0xc0, 0xef, 0xcf, 0xe3]) /* 七里香 */, Buffer.from([0xd6, 0xdc, 0xbd, 0xdc, 0xc2, 0xd7]) /* 周杰伦 */)]));
