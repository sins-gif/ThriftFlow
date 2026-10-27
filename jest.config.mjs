/**
 * Jest 配置（ESM + ts-jest）。
 *
 * 仓库是纯 ESM（package.json type: module）、源码直接 import './model.ts'，
 * 所以这里必须开 ts-jest 的 ESM 模式，并让模块名映射剥掉 .ts 后缀：
 *
 *   node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand
 *
 * --runInBand 是环境要求：沙箱禁止子进程管道，默认的 worker 池会 spawn 失败。
 */
export default {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.ts$': '$1' },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          target: 'ES2022',
          lib: ['ES2022'],
          module: 'ESNext',
          moduleResolution: 'bundler',
          allowImportingTsExtensions: true,
          noEmit: true,
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          types: ['jest', 'node'],
        },
      },
    ],
  },
  // 缓存写进工作区（沙箱外不可写），避免 jest 去碰 $TMPDIR
  cacheDirectory: '<rootDir>/.tmp/jest-cache',
};
