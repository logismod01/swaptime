# UI-тесты (jsdom)

Проверяют фронтенд без браузера: рендер чата, отсутствие дублей сообщений,
ответы, редактирование/удаление, непрочитанные, авторизацию, сессии,
загрузку аватарки, рамки, баннеры и карточку профиля.

```bash
npm install jsdom
node tests/ui/chat.test.js
node tests/ui/auth.test.js
node tests/ui/session.test.js
node tests/ui/profile.test.js
```

Каждый файл — самостоятельный скрипт: поднимает jsdom, подменяет `fetch`
и `WebSocket`, прогоняет сценарий и печатает `✅ ...` при успехе.
