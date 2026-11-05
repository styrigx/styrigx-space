/**
 * @fileoverview 共享 UI 设置 cookie sgx-ui（5.2）：只含 UI 设置（时区、时钟、天气、外观），不含任何凭证或会话信息。
 * 2026-11-04 P5-1（定案第 5 条）：写法搬进外观写端 lib/prefs-write.js（共享外壳 prefs-write.js，四站共用一个写端；子站快捷设置也写它），
 * 这里只保留原来的导入路径（core.js、cloud-sync.js 照旧从这里拿 syncUiCookie）。
 * 契约测试：tests/fixtures/ui-cookie-contract.json（写端真实产出的 cookie + 读端期望结果，共享外壳原样带给子站）。
 */

/* 字段表 / 版本 / 编解码和子站读端共用一份（lib/ui-cookie-read.js，经典脚本，挂 window.SgxUI）：先于写端加载 */
import './ui-cookie-read.js';

export { syncUiCookie } from './prefs-write.js';
