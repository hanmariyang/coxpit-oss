// 셸 문자열 다루기 — 순수 함수만.

/** POSIX 싱글쿼트 이스케이프 — 사용자 경로를 셸 커맨드에 안전하게 삽입. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * 경로 두 개가 같은 곳을 가리키나.
 * /private 접두와 끝 슬래시를 흡수한다 — macOS 의 /var → /private/var 심링크 때문에
 * 문자열 비교만 하면 헛경고가 난다.
 */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\/+$/, '').replace(/^\/private\//, '/');
  return norm(a) === norm(b);
}
