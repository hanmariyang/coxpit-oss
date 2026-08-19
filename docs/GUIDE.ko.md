<!-- DRAFT — 검토 + v4.5(remote access) 병합 대기. "다른 기기에서 접속" 섹션은 스펙 기준으로
     먼저 작성했고 v4.5 반영 시 실제 UX에 맞춰 정합. 아직 미커밋. -->

# Coxpit — 사용 가이드

[English](GUIDE.md) · 한국어

Coxpit은 **AI 코딩 에이전트 여러 대를 내 기계에서 병렬로** 돌립니다. 작업을 하나
주면 에이전트 여러 개를 동시에 띄우는데, 각자 자기만의 git worktree와 브랜치에서
일하고, 그 과정이 전부 브라우저의 보드 하나로 실시간으로 흐릅니다. 지켜보고,
결과를 비교하고, 마음에 드는 하나를 고르면 됩니다.

이 가이드는 "이럴 땐 이렇게" 중심입니다. 처음 세 섹션만 훑으면 바로 시작할 수
있고, 나머지는 필요할 때 골라 보세요. 셋업은 보드의 첫 실행 패널이 알아서
안내하므로, 여기서는 개념과 실제 흐름에 집중합니다.

**목차**
- [설치](#install) · [첫 실행](#first-run) · [첫 플릿](#your-first-fleet) · [승자 고르기](#pick-a-winner)
- 레시피: [두 프로바이더](#recipe-two-providers) · [모델 지정](#recipe-model) · [새 프로젝트 시작](#recipe-greenfield) · [run 이어 지시(steer)](#recipe-steer) · [스웜](#recipe-swarm) · [워크벤치](#recipe-workbench) · [diff 대신 문서로 비교](#recipe-docs) · [아카이브](#recipe-archive) · [run 공유](#recipe-share) · [터미널](#recipe-terminal) · [Design Mode](#recipe-design) · [원격 머신](#recipe-machines) · [다른 기기에서 접속](#recipe-remote) · [폰에서 쓰기](#recipe-mobile)
- [작동 원리](#how-it-works) · [보안](#safety) · [문제 해결](#troubleshooting)

---

<a id="install"></a>
## 설치

Coxpit은 데몬 하나 + SQLite 파일 하나입니다. 편한 방식으로:

```bash
# 가장 빠름 — npm 에서 바로, 설치 없이
COXPIT_AUTH_DISABLED=1 npx coxpit          # → http://127.0.0.1:8210

# 전역 CLI
npm i -g coxpit && coxpit

# Docker
docker run -p 127.0.0.1:8210:8210 -v coxpit:/data ghcr.io/hanmariyang/coxpit

# 데스크톱 앱 (데몬 내장, 자체 창으로 보드를 엶)
# → 랜딩 페이지에서 다운로드, 설치 후엔 자동 업데이트
```

요구사항: Node 20+, `git`, `tmux`, 그리고 PATH에 코딩 에이전트 CLI(기본은 Claude
Code — `claude`). Coxpit은 그 CLI를 그 CLI 자신의 로그인으로 구동합니다. 당신의
키는 coxpit 설정이나 DB에 절대 닿지 않습니다.

> **인증은 fail-closed(잠금 우선)입니다.** `COXPIT_AUTH_DISABLED=1`도 없고
> `COXPIT_AUTH_PASS`도 안 넣으면 **모든 요청이 401로 거부**됩니다. 데몬이 셸을
> 노출하기 때문에 일부러 그렇게 했습니다. 로컬에서는 비밀번호를 넣거나
> (`COXPIT_AUTH_PASS=…`) 인증을 끄세요(`COXPIT_AUTH_DISABLED=1`). 인증이 켜졌는데
> 비밀번호가 없으면 데몬이 부팅 시 경고합니다.

---

<a id="first-run"></a>
## 첫 실행

보드를 엽니다(`http://127.0.0.1:8210`). 빈 보드에는 **셋업 패널**이 이 기계를
점검합니다 — git, tmux, 에이전트 CLI(있으면 Codex도). 전부 초록이면 준비 완료.

이제 작업할 대상이 필요합니다. 두 가지 진입로가 있는데, 새 프로젝트를 시작하는
거라면 첫 번째부터 보세요.

<a id="start-a-new-project-the-easy-on-ramp"></a>
### 새 프로젝트 시작 (가장 쉬운 진입로)

아직 repo가 없나요? 왼쪽 **Context** 패널의 **New**를 누르세요. 빈 폴더(또는 아직
없는 폴더)를 가리키면 coxpit이 `git init`을 하고 빈 초기 커밋을 base로 만들어
줍니다. 당신이 손댈 셋업은 없습니다.

![새 프로젝트를 시작하면 플릿이 스캐폴딩한다](05_new-project.gif)

그 빈 커밋 하나면 플릿이 갈라져 나올 base로 충분합니다. *"Next.js + Tailwind로 …
스캐폴딩해줘"* 같은 태스크를 쓰고 **에이전트 2~3개**를 돌리면, 각자 자기 worktree
에서 프로젝트를 만듭니다. 그다음 [초기 구조를 비교](#pick-a-winner)하고 마음에
드는 걸 `main`에 머지하면 됩니다. coxpit이 뭘 하는지 가장 빨리 *보는* 방법이에요.
빈 폴더에서 시작해 실제 출발점 세 개를 받아 그중 최고를 고르는 거죠. (파일이 이미
있는 폴더는 절대 건드리지 않습니다.)

### 또는 기존 repo 등록

이미 프로젝트가 있다면 **Context**에서 **Browse…**로 폴더를 고르거나(git repo는
배지가 붙습니다) **Path**로 절대경로를 입력하세요. (repo에 커밋이 최소 하나는
있어야 합니다. 없으면 coxpit이 새 프로젝트로 시작하겠냐고 물어봅니다.)

여기서 고른 repo(와 그 위의 머신)가 모든 실행의 대상이 됩니다.

---

<a id="your-first-fleet"></a>
## 첫 플릿

Coxpit은 기본이 **드라이런 모드**입니다 — 모의 에이전트가 전체 파이프라인
(worktree → 브랜치 → tmux → 스트림 → diff → 머지)을 **크레딧 한 푼 안 쓰고**
훑습니다. 첫 실행은 드라이로 돌려서 전체 모양을 보세요:

1. **Start → Task**에서 제목과 프롬프트를 입력.
2. 모드는 **Dry run** 그대로 두고, 개수를 `2`나 `3`으로, **Run fleet**.
3. 카드가 뜨는 걸 지켜봅니다.

![플릿이 일하는 모습](01_live-board.gif)

**카드** 하나가 run 하나입니다. 카드 읽는 법:
- **`rN`** — run 번호. **branch** `coxpit/rN` — 격리된 브랜치.
- **상태 칩** — pending → running → done (또는 failed/stopped/merged).
- **files** — 바꾼 파일 수. **run i/n** — 한 태스크에 run이 여럿이면 몇 번째 시도인지.
- **타임라인** — 에이전트의 단계(출력에서 파싱): `said …`, `tool ▸ Edit — file`, `done`.

카드를 클릭하면 열립니다 — 왼쪽에 전체 **타임라인**, 오른쪽에 **diff**. 준비되면
모드를 **Real agent**로 바꿔 다시 돌리세요. 실 run은 당신 CLI 계정의 크레딧을
씁니다(coxpit이 청구하는 건 없습니다).

---

<a id="pick-a-winner"></a>
## 승자 고르기

플릿의 요점은 "선택"입니다. 아무 run이나 열고 **Compare runs**를 누르면 그 태스크의
모든 시도가 나란히 보입니다:

![diff를 비교하고 승자를 머지](02_compare-merge.gif)

- **Merge this** — run의 worktree를 커밋하고 그 브랜치를 base 브랜치에 머지. base가
  깨끗한지 가드하고, 충돌 시 abort.
- **Open PR** — 대신 브랜치를 push하고 GitHub PR을 엽니다(`gh` 필요).
- **Export files…** (run 모달에서) — 머지 없이 바뀐 파일만 복사. 리포트·일회성용.

어느 게 최선인지 모르겠다면 compare의 **AI review**를 누르세요. 심판 에이전트가 모든
diff를 읽고 접근·장단점·추천을 요약합니다. 코드를 다 읽는 대신 판단만 하면 됩니다.

태스크가 끝나면 **Close task**가 worktree와 브랜치를 정리합니다. 머지도 export도 안
된 변경이 있으면 coxpit이 먼저 경고하니, 작업을 실수로 버리지 않습니다.

---

## 레시피

<a id="recipe-two-providers"></a>
### 같은 태스크를 두 프로바이더로

Coxpit은 **Claude Code**와 **OpenAI Codex**를 구동합니다. Task 패널의 Claude/Codex
토글로 발사마다 고르세요. 같은 태스크를 각각 돌려 두 접근을 비교합니다. steer(아래)
는 각 에이전트를 자기 세션에서 이어갑니다. (세 번째 프로바이더 추가는
`src/providers.ts`에 ~100줄 — 포크가 아니라 PR입니다.)

<a id="recipe-model"></a>
### 발사마다 모델 지정

프로바이더 토글 아래 **model** 칸에 CLI가 받는 모델명을 아무거나 넣으면 됩니다(비우면
CLI 기본값). 탐색 플릿엔 저렴한 모델, 결승 run엔 상위 모델. 최근에 쓴 몇 개는
기억됩니다. 서브 에이전트는 부모의 모델을 물려받습니다.

<a id="recipe-greenfield"></a>
### 맨바닥에서 새 프로젝트

[첫 실행](#start-a-new-project-the-easy-on-ramp)에서 다뤘습니다 — 권장 진입로예요.
요약하면: Context의 **New** → 빈/없는 폴더 → coxpit이 빈 base 커밋 생성 → 플릿이
스캐폴딩 → 비교·머지. 이미 파일이 있는 폴더는 절대 초기화하지 않고(명확한 메시지로
거절) 실수로 기존 디렉터리를 repo로 만드는 일이 없습니다.

<a id="recipe-steer"></a>
### 정착한 run 이어 지시하기(steer)

run은 정착해도 끝이 아니라 이어갈 수 있는 세션입니다. done된 run을 열고 아래
**Work / Ask** 바를 쓰세요:
- **Work** — 다음 지시. 에이전트가 같은 세션·같은 worktree에서 이어갑니다.
- **Ask** — 작업에 대한 질문. 파일을 건드리지 않고 답만 합니다.
- **Sync base** — 오래 사는 run의 worktree에 base 브랜치 최신을 당겨옵니다.

![done된 run에 후속 지시를 보내면 에이전트가 세션을 이어간다](07_steer.gif)

팁: diff의 아무 줄이나 클릭하면 그 줄이 steer 입력에 인용됩니다. 주석 달고, 지시
붙이고, Send.

<a id="recipe-swarm"></a>
### 목표 하나를 스웜으로 쪼개기

두 가지 방식:
- **Goal** (Start에서) — 플래너 에이전트가 repo를 읽고 목표를 독립 태스크들로 쪼개
  전부 발사합니다. 보드에서 **밴드**로 묶여 보입니다.
- **셀프 오케스트레이션** — 실행 중인 에이전트가 자기 worktree에 `.coxpit/spawn.json`
  을 써서 서브 에이전트를 스스로 발사합니다. 데몬이 각각을 격리된 서브런으로 띄우고
  `.coxpit/subtasks.json`으로 현황을 갱신합니다. 서브런엔 `↳ by rN` 배지가 붙습니다.

**Select runs → Integrate**로 수렴합니다. coxpit이 하나씩 머지하고, 충돌하는 run은
큐를 멈추지 않고 해소 에이전트를 대신 띄웁니다.

![목표 하나가 밴드로 펼쳐진다](03_group-band.gif)

<a id="recipe-workbench"></a>
### 워크벤치에서 직접 작업

**Workbench** (Start에서)는 worktree + tmux만 만들고 **에이전트는 안 띄웁니다** —
직접 그 안에서 작업하고 싶을 때(`claude`를 대화형으로 돌리거나 그냥 편집). 카드는
여느 run과 같은 diff / 머지 / PR / export 레일을 그대로 갖습니다.

<a id="recipe-docs"></a>
### diff 대신 렌더된 문서로 비교 (doc 모드)

에이전트가 **문서**를 쓴다면(README, 릴리스 노트, 리포트, HTML 페이지) 날 diff는
판단하기에 나쁩니다. doc 모드는 *렌더된* 결과물을 대신 보여줍니다.

**어디에 있나(이게 놓치기 쉽습니다):** 변경에 `.md`/`.markdown`이나 `.html`이 포함된
run을 여세요. **Diff** 패널 헤더(우상단)에 **Rendered** 버튼이 나타납니다 — 그 run이
실제로 문서를 바꿨을 때만 뜨기 때문에, 코드만 바꾼 run에선 안 보입니다. 그래서 못
찾으셨던 겁니다. 누르면 diff가 서식 문서로 바뀌고, **Diff**를 누르면 되돌아갑니다.

![Rendered 토글이 diff를 서식 문서로 바꾼다](04_doc-mode.gif)

**Compare**에서도 각 열에 같은 토글이 있어서, 리포트 초안 세 개를 diff 셋이 아니라
문서 셋으로 나란히 읽을 수 있습니다.

**worktree보다 오래 삽니다.** 이 문서들은 run이 정착할 때 스냅샷으로 저장되므로,
나중에 그 run을 다시 열면 — 머지·Close 후 [아카이브](#recipe-archive)에서 열어도 —
그대로 렌더됩니다. 라이브가 아니라 스냅샷을 보는 중이면 흐린 안내줄이 알려줍니다.

<a id="recipe-archive"></a>
### 지난 작업을 아카이브에서 찾기

보드는 기본으로 **활성** 작업만 보여줍니다. 닫힌 태스크는 **Archive**(헤더 세그, 개수
표시)로 갑니다. 검색 가능한 목록이라 제목·repo로 거르고, 행을 클릭하면 run이 다시
열립니다. diff는 worktree가 사라졌다고 하지만, **Rendered**는 스냅샷을 계속 보여줍니다.

<a id="recipe-share"></a>
### run 공유하기 (읽기 전용)

run의 **Share** 버튼은 읽기 전용 링크를 만듭니다 — 타임라인, diff, 렌더된 문서,
인증 없음, 액션 없음. 당신 데몬에 닿을 수 있는 사람은 누구나 볼 수 있어서 같은
네트워크의 동료에게 보여주기 좋습니다. (공개 URL이 아닙니다 —
[다른 기기에서 접속](#recipe-remote) 참고.)

<a id="recipe-terminal"></a>
### 터미널로 들어가기

run의 **Terminal**은 그 run의 tmux 세션에 브라우저에서 풀스크린으로 attach합니다.
타이핑하고, 끊고, 손으로 조종하세요. 세션 탭으로 라이브 run 사이를 오갑니다. 폰에서는
입력바가 텍스트를 네이티브로 조합해(한글·일본어 같은 IME가 정상 작동) 완성된 줄을
보내며, esc/tab/^C/방향키도 있습니다.

<a id="recipe-design"></a>
### Design Mode로 UI 맥락 주기

특정 버튼을 다시 스타일링하거나 한 컴포넌트를 고치게 하고 싶은가요? 말로 설명하는
대신 **가리키세요**. **Library** 서랍에서 **⌖ coxpit inspect** 북마클릿을 브라우저
북마크바로 드래그합니다. 그다음 당신의 실행 중인 앱을 열고 그 북마클릿을 누르면
인스펙터가 켜집니다. 아무 요소에나 마우스를 올리면 하이라이트(셀렉터가 보임)되고,
클릭하면 캡처됩니다.

![인스펙터가 당신 앱의 요소를 하이라이트하고 캡처한다](08_design-mode.gif)

캡처(요소의 셀렉터·HTML·computed 스타일)는 coxpit **Library**로 들어갑니다. Task
패널의 **design capture** 드롭다운으로 태스크에 붙이면, coxpit이 그걸 에이전트
프롬프트에 `DESIGN CONTEXT` 블록으로 주입합니다. 당신이 뭘 가리키는지 정확히 보게요.

(인증이 켜져 있으면 북마클릿 스크립트 URL 끝에 `?k=<비밀번호>`를 붙여야 캡처가
허용됩니다. 북마클릿은 로그인 헤더를 못 싣거든요.)

<a id="recipe-machines"></a>
### 다른 머신에서 실행

**원격 머신**을 SSH로 등록하세요(Tailscale이나 LAN). Coxpit이 각 머신의 git/tmux를
프로브하고 거기서 플릿을 돌립니다. 로컬 머신은 그냥 `sh`이고, 원격은 `ssh -tt`로
감싸 터미널 리사이즈가 전파됩니다.

<a id="recipe-remote"></a>
### 다른 기기에서 데몬에 접속

기본적으로 보드는 내 기계의 `IP:포트`에 있습니다. Coxpit은 릴레이를 직접 돌리거나
coxpit 브랜드 URL을 발급하지 않습니다 — 대신 **당신 자신의** Tailscale을 구동하거나
복붙 레시피를 건넵니다. 헤더의 **🔗** 버튼으로 **Remote access** 카드를 여세요(첫
실행 패널에도 있습니다):
- **Serve** (Tailscale이 켜져 있으면 원클릭) — 보드를
  `https://<머신>.<내-tailnet>.ts.net`에 올립니다(HTTPS, 포트 없음). 내 기기들만
  접근 가능, 기본적으로 안전. URL을 복사해 폰에서 여세요.
- **Funnel** — 같은 URL인데 인터넷에 공개. 셸을 노출하므로, 비밀번호를 설정하지
  않으면 coxpit이 켜기를 거부합니다.
- **레시피** — 커스텀 도메인(`coxpit.내도메인.com`)이 필요하면 Cloudflare Tunnel이나
  Caddy 리버스 프록시 스니펫을 복붙(포트가 채워져 있음). 공개 = 인증 켠 채로.

원칙: 내 기기들 안에서만 → **Serve**. tailnet 밖의 누군가가 닿아야 함 → **Funnel**
또는 레시피, 인증 켠 채로.

<a id="recipe-mobile"></a>
### 폰에서 쓰기

보드는 반응형입니다 — 런처는 드로어로 접히고, 카드는 1열, 모달은 풀블리드.
`…/?run=N`은 특정 run으로 딥링크되고, `COXPIT_PUBLIC_URL`을 설정하면 정착 웹훅에
탭 가능한 링크가 들어갑니다. 텔레그램에 물리면 끝난 run이 한 번의 탭 거리예요.

---

<a id="how-it-works"></a>
## 작동 원리

```
브라우저 (보드 · xterm)
   │  HTTP + WebSocket
데몬 — Node/TS · Fastify · SQLite
   │  spawn / ssh
머신 — git worktree · tmux 세션 · 에이전트 CLI
```

- **데몬**이 상태(SQLite 파일 하나)를 소유하고 보드를 서빙합니다.
- 각 **run**은 자기 브랜치의 격리된 **git worktree**이고, 자기 **tmux 세션** 안에
  있습니다. 에이전트가 당신의 체크아웃을 못 건드리고, 어느 run에나 attach할 수 있습니다.
- 외부 도구는 **spawn하지 vendor하지 않습니다**: `git`, `tmux`, 에이전트 CLI.
- 머신당 데몬 하나(`~/.coxpit/` 공유). 데스크톱 앱은 두 번째를 띄우지 않고 이미 도는
  데몬에 attach합니다.

---

<a id="safety"></a>
## 보안

- **데몬은 셸을 노출합니다.** 닿을 수 있는 건 뭐든 당신 기계에서 명령을 실행할 수
  있습니다. 인증을 켜 두고(기본 fail-closed), 공개 노출은 반드시 당신 자신의 접근
  계층(Tailscale, Cloudflare Access, TLS 리버스 프록시)을 앞에 두세요.
- **계정·텔레메트리·클라우드 릴레이 없음.** 데몬은 당신 것이고, 코드는 당신
  네트워크를 벗어나지 않습니다.
- **실 run은 당신 CLI 계정의 크레딧을 씁니다** — coxpit이 청구하는 건 없습니다.
  드라이런은 무료이고 전체 파이프라인을 훑습니다.

---

<a id="troubleshooting"></a>
## 문제 해결

- **모든 요청이 401.** 인증이 켜졌는데 비밀번호가 없습니다(fail-closed).
  `COXPIT_AUTH_PASS`를 넣거나 로컬 개발이면 `COXPIT_AUTH_DISABLED=1`.
- **등록 시 "this repository has no commits yet".** worktree가 갈라져 나올 커밋이
  최소 하나 필요합니다. 초기 커밋을 만들거나 **New**로 새 프로젝트를 시작하세요(coxpit이
  빈 base 커밋을 대신 만듭니다).
- **머지가 거부됨.** repo가 base 브랜치 위에 있고 깨끗해야 합니다. repo가 `main`이
  아니라 `develop`을 쓰면 Context의 **⎇** 버튼으로 base 브랜치를 지정하세요 — 머지,
  Sync base, PR이 그 브랜치를 향합니다.
- **Windows.** 로컬 에이전트 run엔 POSIX 셸 + tmux가 필요합니다 — 데몬을 WSL2 안에서
  돌리세요. 네이티브 Windows 데몬도 보드를 서빙하고 원격(ssh) 머신은 구동할 수 있습니다.

---

전체 설정 레퍼런스와 아키텍처는 [README](../README.md)에 있습니다. 버그를 찾았거나
기능을 원하면 이슈를 열어주세요.
