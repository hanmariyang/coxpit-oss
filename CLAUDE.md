# Coxpit (OSS v2.0) — Workspace Guide

> **개인 Coxpit(`projects/coxpit`)의 OSS 스핀아웃.** 이름은 그대로 Coxpit, 하지만 **완전 별개 신규 코드베이스(Node/TS)**. 목표는 시장 경쟁이 아니라 "개인도 이런 오픈소스를 낼 수 있음"의 증명·공유·자용. **개인 배선(Triforge·원탁·시크릿·워크스페이스)은 절대 포함하지 않는다.**

**Last Updated**: 2026-08-18 · **Status**: **P1 에이전트 플릿 + P2 비교/리뷰 완료**(전부 실측 검증) · License: MIT

---

## 1. 프로젝트 개요

- **무엇**: 내가 소유하는 · 웹/폰 어디서나 · 여러 내 머신 위에서 **AI 코딩 에이전트 플릿을 병렬 worktree로 띄우고·비교·머지**하는 자가호스트 코크핏.
- **정체성 축**: owner-first · 웹 우선 · 멀티머신. (Orca/Paseo를 합친 게 아니라 그 패러다임을 이 각으로 다시 그림.)
- **v1 컷**: 웹 대시보드 · 다중 터미널 · 멀티머신 · 인증(basic+plugin) · 에이전트 플릿 · 비교/리뷰 · Design Mode · 파일 브라우저. (**code-server 제외** — 터미널 우선)

## 2. 아키텍처

- **데몬**(이 repo): Node/TS(Fastify + WebSocket), SQLite(Drizzle). 에이전트를 spawn(각 = git worktree + tmux 창 + 브랜치), stream 파싱 → WS 로 보드에 라이브.
- **프론트**: Next.js(추후 이식 — 개인 Coxpit UI 재사용).
- **원격 머신**: SSH(Tailscale/LAN). **외부 도구 spawn**: tmux, 에이전트 CLI(claude-code 우선). 번들 없음.

## 3. 기술 스택

Fastify · @fastify/websocket · @libsql/client(SQLite, NAPI 프리빌드 = 노드버전 무관) · drizzle-orm · (추후) node-pty · ssh2 · simple-git. Dev: tsx · typescript · drizzle-kit.

## 4. 디렉토리

```
coxpit-oss/
├── src/
│   ├── index.ts          <- 엔트리(스키마 부트 + 로컬 머신 시드 + listen)
│   ├── server.ts         <- Fastify + WS + 라우트
│   ├── auth.ts           <- 인증 게이트(basic, 플러그형)
│   ├── config.ts         <- env 설정(시크릿 주입)
│   └── db/{schema,index}.ts  <- Machine·Repo·Task·AgentRun·AgentEvent
├── drizzle.config.ts · package.json · tsconfig.json
├── .env.example (값 없이 키만) · LICENSE(MIT) · README.md
```

## 5. 개발 환경

```bash
npm install
cp .env.example .env      # COXPIT_AUTH_PASS 설정 또는 COXPIT_AUTH_DISABLED=1
npm run dev               # 데몬 http://127.0.0.1:8210
npm run typecheck
```
포트: **8210**(데몬) · 3210(웹, 추후). — 워크스페이스 §5 와 충돌 없음.

## 6. 배포 환경

자가호스트(사용자가 자기 머신/서버에). 배포 채널: GitHub Releases · GHCR(공개 Docker) · npm. **인프라 비용 0(SaaS 아님).** 프로덕션 앞단 = CF Access/Tailscale 권장(내부 인증 off 위임).

## 7. 외부 의존성

tmux · git · 에이전트 CLI(claude-code 등) — 사용자 환경에 설치. 시크릿(에이전트 API 키 등)은 사용자 주입.

## 8. 프로젝트 규약

- **개인 배선 반입 금지.** Triforge·원탁·EduOps·워크스페이스 회랑·시크릿·개인 도메인/경로 절대 포함 X.
- **Paseo(AGPL) 코드 차용 금지** — 아이디어만. Orca(MIT) 패턴 차용 가능.
- 공개 전 `predeploy-guard` 스캔 필수.
- 개인 Coxpit(`projects/coxpit`)과 **완전 분리** — 드리프트 시 코어를 공용화하되 개인은 그 위 배선.

## 9. 주의사항

- **P1 완료 범위**: 머신 등록+SSH 프로브 · repo 등록(work-tree 검증) · Task→run×N(격리 worktree+브랜치+tmux 창) · claude 헤드리스 stream-json 파싱(드라이런/실제 동일 파서, 실제 opus 검증) · `GET /` 플릿 보드(WS 라이브·run 상세 모달=타임라인+diff+stop/cleanup) · task close(전 run 정지+정리). stop 은 프로세스 그룹 kill(손자 에이전트 포함).
- **P2 비교/리뷰 완료**: `GET /api/tasks/:id/compare`(전 run diff 나란히) + `POST /api/runs/:id/merge`(worktree 자동 커밋→본 repo 가드[기본 브랜치+클린]→`merge --no-ff`, 충돌 시 자동 abort·409, 실행 중 run 거부) + 보드 비교 오버레이(run 컬럼별 diff·merge 버튼·merged 칩).
- 기본은 **드라이런**(`COXPIT_AGENT_REAL=1` 켜야 실제 CLI — 크레딧 소모). 헤드리스 권한 `COXPIT_AGENT_PERM`(기본 acceptEdits).
- 원격 run stop 은 ssh 종료 기반 — 원격 프로세스 잔존 가능(P2 에서 tmux 경유 kill 로 보강 예정).
- 라이브 터미널 attach(tmux 웹 접속)는 P2 멀티 터미널로 이월.
- 신규 의존성 도입 시 라이선스 감사(GPL/AGPL 전염 금지). — 2026-08-18 프로덕션 트리 123패키지 감사: copyleft 0 (MIT 73·ISC 7·BSD 6·Apache 2, 나머지는 미설치 옵셔널 피어).
- **공개 push 전 수동 2건**: ① 이 CLAUDE.md 는 워크스페이스 참조(개인 프로젝트명·상대경로)를 포함 — public repo 에는 일반화판으로 교체하거나 제외. ② `.env.example` 에 `COXPIT_SSH_KEY`·`COXPIT_AGENT_REAL/BIN/PERM` 키 추가(세션 시크릿 가드로 자동수정 불가). 코드·README 는 스캔 클린(개인 배선 0·시크릿 패턴 0).

설계 상세: `../coxpit/Docs/v2.0/plan/` (direction · extraction · feature_selection · p1_agent_fleet).
