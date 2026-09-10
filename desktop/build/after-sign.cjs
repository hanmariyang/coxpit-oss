// electron-builder afterSign 훅 — 서명 직후·공증 전에 실행된다.
//
// 왜 필요한가: macOS codesign 이 node-pty 의 `spawn-helper`(중첩 Mach-O 실행파일)를
// 서명하면서 POSIX 실행 비트를 644 로 되돌린다. 그러면 앱은 정상 서명·공증되지만
// 설치된 곳에서 node-pty 가 helper 를 exec 하지 못해 모든 터미널이 `posix_spawnp failed`
// 로 죽는다. 설치된 앱 번들은 불변(SIP)이라 런타임 chmod(term.ts 가드)도 막힌다 →
// 유일한 근본 해결은 배포 전에 실행 비트를 되살리는 것.
//
// 안전성: 파일 모드 비트는 코드 서명 해시(파일 내용)에 포함되지 않으므로 chmod 는
// 서명을 무효화하지 않고, 공증(서명 검사)에도 영향이 없다. 이 훅이 공증 전에 돌아
// 최종 .app → dmg 에 755 가 그대로 실린다.
const { chmodSync } = require('node:fs');
const { join } = require('node:path');

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = context.packager.appInfo.productFilename; // "Coxpit"
  const nodePty = join(
    context.appOutDir, `${appName}.app`, 'Contents', 'Resources',
    'daemon', 'node_modules', 'node-pty',
  );
  const targets = [];
  for (const arch of ['darwin-arm64', 'darwin-x64']) {
    targets.push(join(nodePty, 'prebuilds', arch, 'spawn-helper'));
  }
  targets.push(join(nodePty, 'build', 'Release', 'spawn-helper')); // 소스빌드 fallback
  for (const f of targets) {
    try { chmodSync(f, 0o755); console.log('[after-sign] restored +x:', f); }
    catch (e) { console.log('[after-sign] skip (absent):', f); }
  }
};
