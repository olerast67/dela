import { describe, expect, it } from 'vitest';
import { apkFromLatest, apkFromSums, cachedRelease, checkDue, compareVersions, isAllowedRedirect, isDebugVersion, isReleaseUrl, latestVersion } from '../src/appUpdate.ts';

const SHA = 'cbc0224b5bb476d3389d49f8f9ed5bd0fd4af6cb0ba2d145f5a126ecbc4915c4';
const APK = 'https://github.com/olerast67/dela/releases/download/v1.0.1/Dela-1.0.1-android.apk';

describe('compareVersions', () => {
  it('сравнивает числа, а не строки', () => {
    expect(compareVersions('1.0.10', '1.0.9')).toBeGreaterThan(0);
    expect(compareVersions('1.2.0', '1.10.0')).toBeLessThan(0);
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
    expect(compareVersions('1.0.1', '1.0.1')).toBe(0);
    expect(compareVersions('v1.0.2', '1.0.1')).toBeGreaterThan(0);
  });

  it('версия с суффиксом старше выпуска без него', () => {
    expect(compareVersions('1.1.0', '1.1.0-beta.2')).toBeGreaterThan(0);
    expect(compareVersions('1.1.0-beta.2', '1.1.0-beta.10')).toBeLessThan(0);
    expect(compareVersions('1.1.0-alpha', '1.1.0-beta')).toBeLessThan(0);
  });

  it('непонятная версия не считается новее', () => {
    expect(compareVersions('latest', '1.0.0')).toBe(0);
    expect(compareVersions('1.0', '0.9.0')).toBe(0);
  });

  it('отладочная сборка узнаётся по суффиксу', () => {
    expect(isDebugVersion('1.0.1-debug')).toBe(true);
    expect(isDebugVersion('1.0.1')).toBe(false);
  });
});

describe('выбор файла', () => {
  it('APK из поля android в latest.json', () => {
    expect(apkFromLatest({ version: '1.0.1', platforms: {}, android: { url: APK, sha256: SHA.toUpperCase() } })).toEqual({ version: '1.0.1', url: APK, sha256: SHA });
  });

  it('чужой адрес или кривая сумма в latest.json не принимаются', () => {
    expect(apkFromLatest({ version: '1.0.1', android: { url: 'https://evil.example/Dela.apk', sha256: SHA } })).toBeNull();
    expect(apkFromLatest({ version: '1.0.1', android: { url: APK, sha256: 'abc' } })).toBeNull();
    expect(apkFromLatest({ version: '1.0.1' })).toBeNull();
    expect(latestVersion({ version: 'x' })).toBeNull();
  });

  it('из SHA256SUMS.txt берётся APK телефона, а не часов', () => {
    const sums = [
      `ceda11a28e79aa7bdfb001edb72d8b4309e6d749ff47f6dd883e8b206631a073  Dela-1.0.1-wear.apk`,
      `${SHA}  Dela-1.0.1-android.apk`,
      `e71503d18457f370cefa036eda1c8b0126416722b66b1938d266f7092602ef96  Dela_1.0.1_x64-setup.exe`,
    ].join('\n');
    expect(apkFromSums('1.0.1', sums)).toEqual({ version: '1.0.1', url: APK, sha256: SHA });
    expect(apkFromSums('1.0.2', sums)).toBeNull();
  });

  it('запомненная версия проверяется так же', () => {
    expect(cachedRelease(JSON.stringify({ version: '1.0.1', url: APK, sha256: SHA }))).toEqual({ version: '1.0.1', url: APK, sha256: SHA });
    expect(cachedRelease(JSON.stringify({ version: '1.0.1', url: 'https://evil.example/a.apk', sha256: SHA }))).toBeNull();
    expect(cachedRelease('{')).toBeNull();
    expect(cachedRelease(null)).toBeNull();
  });

  it('проверка не чаще раза в сутки', () => {
    const day = 24 * 60 * 60 * 1000;
    expect(checkDue(day * 10, null)).toBe(true);
    expect(checkDue(day * 10, day * 10 - 1000)).toBe(false);
    expect(checkDue(day * 10, day * 9)).toBe(true);
    // часы перевели назад
    expect(checkDue(day * 10, day * 11)).toBe(true);
  });
});

describe('разрешённые адреса', () => {
  it('только выпуски Dela на github.com по https', () => {
    expect(isReleaseUrl(APK)).toBe(true);
    expect(isReleaseUrl('https://github.com/olerast67/dela/releases/latest/download/latest.json')).toBe(true);
    expect(isReleaseUrl('http://github.com/olerast67/dela/releases/latest/download/latest.json')).toBe(false);
    expect(isReleaseUrl('https://github.com/olerast67/dela-fork/releases/download/v1/a.apk')).toBe(false);
    expect(isReleaseUrl('https://github.com/evil/dela/releases/download/v1/a.apk')).toBe(false);
    expect(isReleaseUrl('https://github.com/olerast67/dela/releases/../../evil/x/releases/a.apk')).toBe(false);
    expect(isReleaseUrl('https://github.com/olerast67/dela/releases/%2e%2e/%2e%2e/evil/a.apk')).toBe(false);
    expect(isReleaseUrl('https://github.com.evil.example/olerast67/dela/releases/a.apk')).toBe(false);
    expect(isReleaseUrl('https://user@github.com/olerast67/dela/releases/a.apk')).toBe(false);
    expect(isReleaseUrl('https://github.com:8443/olerast67/dela/releases/a.apk')).toBe(false);
    expect(isReleaseUrl('не адрес')).toBe(false);
  });

  it('переадресация — только в хранилища файлов GitHub', () => {
    expect(isAllowedRedirect('https://release-assets.githubusercontent.com/github-production-release-asset/1/2?sp=r')).toBe(true);
    expect(isAllowedRedirect('https://objects.githubusercontent.com/github-production-release-asset-2e65be/1')).toBe(true);
    expect(isAllowedRedirect(APK)).toBe(true);
    expect(isAllowedRedirect('https://raw.githubusercontent.com/evil/x/main/a.apk')).toBe(false);
    expect(isAllowedRedirect('http://objects.githubusercontent.com/a')).toBe(false);
    expect(isAllowedRedirect('https://evil.example/a.apk')).toBe(false);
  });
});
