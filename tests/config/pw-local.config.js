const base = require('./playwright.config.js');
module.exports = {
  ...base,
  testMatch: process.env.PW_MATCH ? process.env.PW_MATCH.split(',') : base.testMatch,
  outputDir: '../../test-results/topsearch',
  webServer: { command: 'npx http-server ../../web/public -p 8994 -s', port: 8994, reuseExistingServer: true },
  use: { ...base.use, baseURL: 'http://localhost:8994' },
  reporter: [['line']],
};
