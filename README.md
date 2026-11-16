# usage-meter

Claude Code의 사용량을 프롬프트 입력창 바로 위에 색 띠로 보여 주는 모드입니다.

- 컨텍스트 사용률, 5시간·7일 사용 한도, 이 세션 비용을 막대와 퍼센트로 표시합니다.
- 80% 미만은 초록, 80% 이상은 노랑, 90% 이상은 빨강으로 바뀝니다.
- 한도가 80%, 90%를 넘는 순간 한 번씩 알림을 띄웁니다.
- `/usage-meter` 명령으로 토큰 수와 초기화 시각까지 자세히 볼 수 있습니다.

## 설치

터미널 세션의 프롬프트에서:

```
/plugin install usage-meter --marketplace scalper86/usage_meter
```

셸에서:

```
claude plugin install usage-meter --marketplace scalper86/usage_meter
```

`Add marketplace?`에는 `y`로 답하고, 범위는 user를 고릅니다.

`/plugin`이 동작하지 않는 데스크톱 앱에서는 프롬프트 입력창 옆 `+` → Plugins → Add marketplace에 `scalper86/usage_meter`를 넣은 뒤 Add plugin을 누릅니다.

설치한 뒤 새로 시작하는 세션부터 띠가 보입니다.

## 업데이트

이 저장소에 새 커밋이 올라오면 그것이 곧 새 버전입니다. 받는 방법은 두 가지입니다.

직접 받기 (셸에서):

```
claude plugin update usage-meter@usage-meter
```

터미널 세션의 프롬프트에서는 다음 명령으로도 됩니다.

```
/plugin marketplace update usage-meter
```

자동으로 받기: 터미널 세션에서 `/plugin` → Marketplaces → `usage-meter` → Enable auto-update를 한 번 켜 두면, 세션을 시작할 때마다 새 버전을 확인해 받아 옵니다.

업데이트는 새로 시작하는 세션부터 적용됩니다.

GitHub SSH 키가 없는 컴퓨터에서 업데이트가 실패하면 환경 변수 `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1`을 설정한 뒤 다시 시도하세요.
