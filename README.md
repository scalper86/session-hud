# session-hud

Claude Code로 개발할 때 세션 상태를 한눈에 보여 주는 모드입니다. 예전 이름은 `usage-meter`입니다.

## 기능

- **사용량 띠**: 프롬프트 입력창 바로 위에 컨텍스트 사용률, 사용 한도(5시간·7일, 모델별 한도가 따로 오면 `7일(Fable)`처럼 따로), 세션 비용을 막대와 퍼센트로 표시합니다. 80% 미만은 초록, 80% 이상은 노랑, 90% 이상은 빨강입니다.
- **변경 파일 패널**: 이번 세션에서 Edit·Write로 바뀐 파일과 추가·삭제 줄 수를 대화 옆 패널에 보여 줍니다. 처음 파일이 바뀔 때 열리고, 띠에도 합계가 나옵니다.
- **완료 알림**: 오래 걸린 작업이 끝나면 시스템 알림을 보냅니다. 알림을 보낼 수 없으면 화면 안 알림으로 대신합니다.
- **세션 예산 경고**: 세션 비용이 예산의 80%와 100%에 닿을 때, 컨텍스트가 기준을 넘을 때, 사용 한도가 80%·90%를 넘을 때 한 번씩 알립니다.
- **`/session-hud` 명령**: 토큰 수, 초기화 시각, 비용, 변경 파일 합계를 자세히 보여 주고 변경 파일 패널을 엽니다.

Bash 명령(`git`, `sed` 등)으로 바뀐 파일은 변경 파일 패널에 잡히지 않습니다.

## 설치

터미널 세션의 프롬프트에서:

```
/plugin install session-hud --marketplace scalper86/session-hud
```

셸에서:

```
claude plugin install session-hud --marketplace scalper86/session-hud
```

`Add marketplace?`에는 `y`로 답하고, 범위는 user를 고릅니다.

`/plugin`이 동작하지 않는 데스크톱 앱에서는 프롬프트 입력창 옆 `+` → Plugins → Add marketplace에 `scalper86/session-hud`를 넣은 뒤 Add plugin을 누릅니다.

설치한 뒤 새로 시작하는 세션부터 적용됩니다.

## 설정

설치할 때, 또는 터미널 세션의 `/config`에서 바꿀 수 있습니다.

| 항목 | 기본값 | 뜻 |
| --- | --- | --- |
| 세션 예산 (USD) | 5 | 세션 비용이 이 금액의 80%와 100%에 닿으면 알립니다. 0이면 끕니다. |
| 컨텍스트 경고 기준 (%) | 80 | 컨텍스트 사용률이 이 값을 넘으면 알립니다. 0이면 끕니다. |
| 완료 알림 기준 (초) | 30 | 이 시간보다 오래 걸린 작업이 끝나면 알립니다. 0이면 끕니다. |
| 변경 파일 패널 자동 열기 | 켬 | 세션에서 처음 파일이 바뀔 때 패널을 엽니다. |

## 업데이트

이 저장소에 새 커밋이 올라오면 그것이 곧 새 버전입니다. 받는 방법은 두 가지입니다.

직접 받기 (셸에서):

```
claude plugin update session-hud@scalper86-mods
```

터미널 세션의 프롬프트에서는 다음 명령으로도 됩니다.

```
/plugin marketplace update scalper86-mods
```

자동으로 받기: 터미널 세션에서 `/plugin` → Marketplaces → `scalper86-mods` → Enable auto-update를 한 번 켜 두면, 세션을 시작할 때마다 새 버전을 확인해 받아 옵니다.

업데이트는 새로 시작하는 세션부터 적용됩니다.

GitHub SSH 키가 없는 컴퓨터에서 업데이트가 실패하면 환경 변수 `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1`을 설정한 뒤 다시 시도하세요.

## usage-meter를 쓰던 경우

마켓플레이스 이름도 `usage-meter`에서 `scalper86-mods`로 바뀌었습니다. 아래 순서로 다시 설치하세요.

```
claude plugin marketplace remove usage-meter
```

```
claude plugin install session-hud --marketplace scalper86/session-hud
```
