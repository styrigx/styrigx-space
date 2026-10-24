/**
 * @fileoverview 页面入口：主站顶栏三栏（主页 / 聊天 / 设置，2026-10-24 起三页共用这一份）=
 * 公共 core + 三栏各自的模块 + 页内切换（shell/inpage-tabs.js）。
 * 三个地址照旧各自直出完整 HTML；进来以后另外两栏在同一个文档里切换，脚本不重跑、core 只初始化一次。
 */
import { initCore } from '../shell/core.js';
import { initInpageTabs, registerTab } from '../shell/inpage-tabs.js';
import { mountHome } from '../apps/index.js';
import { mountChat } from '../apps/chat.js';
import { mountSettings } from '../apps/settings.js';

registerTab('home', { keep: true, top: true, mount: (o) => mountHome(o) });
registerTab('chat', { keep: true, mount: () => mountChat() });
registerTab('settings', { keep: false, mount: () => mountSettings() });
/* 先挂当前这一栏（同以前：页面模块先跑，core 后初始化） */
initInpageTabs();
initCore();
