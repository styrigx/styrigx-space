/* 2.4.0-G：编译期功能开关（Hugo js.Build define 注入，esbuild 替换为 true/false）。
   由 data/features.yaml 生成，保持同步。 */
declare const SGX_FEAT_THEME_MODE: boolean;
declare const SGX_FEAT_PALETTE: boolean;
declare const SGX_FEAT_LAYOUT: boolean;
declare const SGX_FEAT_LANG: boolean;
/* P4-2c：时钟 / 日期和时间、天气、快捷键、搜索引擎的开关随功能删除 */
declare const SGX_FEAT_ADDRBAR_POS: boolean;
declare const SGX_FEAT_FILES_VIEW: boolean;
declare const SGX_FEAT_FILES_HOME: boolean;
declare const SGX_FEAT_WELL_TIP: boolean;
/* 2.8.0：SGX_FEAT_LEGACY_LOCK_SCREEN 已彻底删除 */
declare const SGX_FEAT_LOCK_GATE: boolean;
/* Hark：CI 测试构建期禁用锁屏（SGX_TEST_NO_LOCK=1 时）；生产构建为 false */
declare const SGX_TEST_NO_LOCK: boolean;
/* B2-7：CI 静态测试构建（SGX_TEST_NO_WEATHER=1）不调 /api/wellbeing；生产构建为 false */
declare const SGX_TEST_NO_WB: boolean;
