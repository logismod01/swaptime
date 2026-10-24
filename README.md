# СвапТайм 💬

Мессенджер на FastAPI + WebSocket с красно-чёрным интерфейсом.
Один процесс отдаёт и API, и фронтенд.

## Запуск

```bash
pip install -r requirements.txt
python backend/server.py
```

Открыть <http://localhost:8000>.

База (`data/swaptime.db`) создаётся автоматически. Старая база от предыдущей
версии тоже подхватывается: недостающие колонки добавляются при старте,
а старые пароли (SHA-256) продолжают работать и незаметно обновляются
до PBKDF2 при первом входе.

Тесты:

```bash
pip install pytest httpx websockets
python -m pytest tests -q
```

## Что умеет

- регистрация с капчей и вход по токену;
- друзья: заявки (входящие/исходящие), удаление, блокировка, игнор;
- личные чаты в реальном времени (WebSocket), история последних 200 сообщений;
- **счётчик непрочитанных** с бейджем `1…99+`, синхронизация между вкладками;
- **ответы на сообщения** с цитатой автора и переходом к оригиналу;
- **редактирование и удаление** — изменения сразу видны обоим собеседникам;
- **10 шрифтов** в настройках с живым предпросмотром;
- онлайн-статус, «печатает…», смена имени и цвета аватарки;
- адаптивная вёрстка (на телефоне чат открывается на весь экран).

## Структура

```
backend/server.py     API + WebSocket + отдача фронтенда
frontend/index.html   разметка
frontend/script.js    вся логика клиента
frontend/style.css    стили
tests/test_smoke.py   сквозной тест API и WebSocket
data/swaptime.db      база SQLite
```

## API (кратко)

Токен принимается тремя способами (в порядке приоритета):
`Authorization: Bearer <token>`, `?token=<token>` и HttpOnly-cookie,
которую сервер ставит при входе. Cookie и query — запасные пути на случай,
если прокси срезает заголовок `Authorization`.

| Метод | Адрес | Что делает |
|-------|-------|------------|
| POST | `/api/register`, `/api/login`, `/api/logout` | аккаунт и сессия |
| GET | `/api/me` | текущий пользователь + список шрифтов |
| GET | `/api/chats` | чаты: последнее сообщение, непрочитанные, онлайн |
| GET | `/api/messages/{u1}/{u2}` | история диалога (последние 200) |
| POST | `/api/mark_read` | отметить чат прочитанным |
| POST | `/api/messages/edit`, `/api/messages/delete` | правка/удаление (REST-фолбэк) |
| GET/POST | `/api/friends*` | заявки, блокировки, игнор |
| POST | `/api/update_profile` | имя, цвет, шрифт |
| WS | `/ws?token=...` | сообщения, правки, удаления, typing, presence |

События WebSocket: `message`, `message_updated`, `read`, `read_sync`,
`typing`, `presence`, `friend_request`, `friend_changed`,
`profile_updated`, `error`, `pong`.
