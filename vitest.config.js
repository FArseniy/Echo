/** @type {import('vitest/config').UserConfig} */
module.exports = {
  test: {
    fileParallelism: false,
    globals: true,
    include: ['test/**/*.test.js'],
    pool: 'forks',
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
};
