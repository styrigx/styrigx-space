/**
 * @fileoverview 首帧语言跳转用（P4-3 PR-4c）：把 lib/lang-path.js 挂到 window.SgxLang。
 * baseof.html 用 js.Build（iife）打包后原样内联进 <head>，和 ES 模块用的是同一份规则，不另写一份。
 */
import { pathLang, stripLang, langPath, langSwitch, systemLang } from './lang-path.js';

/** @type {any} */ (window).SgxLang = { pathLang, stripLang, langPath, langSwitch, systemLang };
