/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  // TypeScript only: the one plain-JS file Jest loads (test/jest.setup.js) is
  // CommonJS that Node runs as-is — sending it through ts-jest without
  // `allowJs` only produced a warning on every uncached run.
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  setupFiles: ['<rootDir>/../test/jest.setup.js'],
  testTimeout: 30000,
};
