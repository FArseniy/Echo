# Echo

[English version](README.md)

Echo — временный чат без регистрации. Комнаты, сообщения, PIN-хеши, сессии и временные счётчики существуют только в оперативной памяти сервера и исчезают после перезапуска или удаления комнаты.

```text
              HTTPS / WSS
Браузер ───────────────────► Nginx ─────► Echo (Express + Socket.IO)
  │                             │                    │
  │ sessionStorage:             │                    ├─ комнаты (память)
  │ краткий токен сессии        │                    ├─ сообщения (память)
  └─────────────────────────────┴────────────────────┴─ bcrypt-хеши PIN

Без аккаунтов · Без базы данных · Без постоянной истории
```

## Защита

| Область | Реализация |
| --- | --- |
| PIN комнаты | 4–8 цифр, хранится только как bcrypt-хеш; никогда не попадает в URL или хранилище браузера |
| Сессии | Случайный краткоживущий токен для одной комнаты, хранится только в `sessionStorage` |
| XSS | Данные выводятся через `textContent`; Helmet CSP блокирует внедрённые скрипты |
| Socket.IO | Строгая проверка Origin, лимит пакета, серверные роли и принадлежность к комнате |
| Защита от злоупотреблений | Лимиты на PIN, подключения, создание и вход в комнаты, typing и сообщения |
| Удаление | Пустые, неактивные и закрытые комнаты очищают все данные из памяти |

## Структура проекта

```text
mini-chat/
├── .env.example
├── .gitignore
├── package.json
├── server.js
├── public/                 # HTML, CSS, vanilla JavaScript
├── src/                    # комнаты, сессии, лимиты, Socket.IO
├── test/                   # Vitest + Supertest + socket.io-client
├── vitest.config.js
└── deploy/
    ├── mini-chat.service
    ├── mini-chat-hardening.conf
    └── nginx/
        └── echo.erised.click.conf
```

Файл `.env` уже указан в `.gitignore`: не добавляйте его в Git, публичные архивы или логи.

## Переменные окружения

Скопируйте шаблон и подставьте свой HTTPS-домен. `CLIENT_ORIGIN` — точный origin браузера со схемой и доменом, без завершающего `/`. Шаблоны `*` намеренно не поддерживаются.

```bash
cp .env.example .env
```

```dotenv
NODE_ENV=production
PORT=3000
PUBLIC_URL=https://echo.example.com
CLIENT_ORIGIN=https://echo.example.com
MAX_SOCKET_PACKET_BYTES=10240
MAX_ROOM_PARTICIPANTS=20
MAX_MESSAGE_LENGTH=2000
ROOM_TTL_MINUTES=360
EMPTY_ROOM_TTL_MINUTES=10
ROOM_CLEANUP_INTERVAL_MINUTES=5
PIN_ATTEMPT_LIMIT=5
PIN_BLOCK_MINUTES=5
```

`MAX_SOCKET_PACKET_BYTES` ограничивает размер пакета Socket.IO на транспортном уровне. Дополнительно приложение проверяет имена, PIN, текст сообщений и лимиты комнат. Жёсткий максимум — 50 участников и 2 000 символов в сообщении.

## Установка на Ubuntu/Debian

Nginx — единственный публичный процесс. Node.js работает от непривилегированного пользователя и слушает только loopback-интерфейс.

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
sudo mkdir -p /opt/mini-chat
sudo chown -R "$USER":"$USER" /opt/mini-chat
# Загрузите или склонируйте проект в /opt/mini-chat.
cd /opt/mini-chat
cp .env.example .env
npm install --omit=dev
sudo chown -R www-data:www-data /opt/mini-chat
```

В `/opt/mini-chat/.env` задайте настоящий `PUBLIC_URL`, `CLIENT_ORIGIN` и нужный `PORT`. Для разработки и тестов используйте `npm install`, затем `npm test`.

## systemd

Проект содержит [deploy/mini-chat.service](deploy/mini-chat.service):

```bash
sudo install -m 0644 deploy/mini-chat.service /etc/systemd/system/mini-chat.service
sudo systemctl daemon-reload
sudo systemctl enable --now mini-chat
sudo systemctl status mini-chat
curl -fsS http://127.0.0.1:3000/healthz
```

Сервер корректно обрабатывает `SIGTERM` и `SIGINT`: останавливает уборщик комнат, уведомляет подключённые клиенты, закрывает Socket.IO и HTTP-сервер. `systemd` ждёт до десяти секунд.

Не устанавливайте `deploy/mini-chat-hardening.conf` вместе с полным unit-файлом: тот уже содержит те же ограничения песочницы. Drop-in нужен только для ранее созданного unit.

## Nginx, HTTPS и WebSocket

Скопируйте [deploy/nginx/echo.erised.click.conf](deploy/nginx/echo.erised.click.conf) в `/etc/nginx/sites-available/`, поменяйте домен и upstream-порт при необходимости, затем включите сайт:

```bash
sudo ln -s /etc/nginx/sites-available/echo.erised.click /etc/nginx/sites-enabled/echo.erised.click
sudo nginx -t
sudo systemctl reload nginx
```

Блок `map` из комментария в начале конфигурации нужно один раз добавить в `http {}` файла `/etc/nginx/nginx.conf`. Путь `/socket.io/` использует HTTP/1.1, передаёт `Upgrade` и `Connection`, отключает буферизацию и задаёт увеличенные таймауты. Не открывайте Node.js-порт наружу: upstream должен быть `127.0.0.1:PORT`.

Перед выдачей сертификата создайте DNS-запись `A` или `AAAA`, направленную на сервер, и убедитесь, что доступны порты 80 и 443:

```bash
sudo certbot --nginx -d echo.erised.click
sudo systemctl enable --now certbot.timer
sudo certbot renew --dry-run
```

HSTS включайте только после того, как HTTPS стабильно работает на финальном домене и нужных поддоменах.

## Логи и обновление

Helmet добавляет CSP и заголовки безопасности. Socket.IO принимает соединения только с `CLIENT_ORIGIN`. Логи содержат только технические метаданные: имя события, socket ID, IP и тип ошибки. PIN, токены, содержимое сообщений, хеши PIN и полные payload не журналируются.

```bash
sudo journalctl -u mini-chat -f
```

При перезапуске временные комнаты и сообщения намеренно теряются. Перед обновлением сохраните `.env` отдельно или оставьте его на месте:

```bash
sudo systemctl stop mini-chat
cd /opt/mini-chat
# Обновите исходный код, не заменяя .env.
npm install --omit=dev
sudo chown -R www-data:www-data /opt/mini-chat
sudo systemctl daemon-reload
sudo systemctl start mini-chat
curl -fsS http://127.0.0.1:3000/healthz
sudo nginx -t && sudo systemctl reload nginx
```

Для релиза с проверкой тестов сначала выполните `npm install && npm test`, а перед запуском production — `npm prune --omit=dev`. После добавления lock-файла используйте `npm ci` вместо `npm install`.

## Проверка после публикации

```bash
curl -fsS https://echo.erised.click/healthz
curl -I http://echo.erised.click
curl -i -H 'Origin: https://echo.erised.click' \
  'https://echo.erised.click/socket.io/?EIO=4&transport=polling'
```

Первый запрос должен вернуть `{"status":"ok"}`, второй — перенаправить на HTTPS, третий — вернуть Socket.IO handshake и точный `Access-Control-Allow-Origin`. Затем откройте две вкладки браузера: создайте комнату в одной, войдите во второй и убедитесь в Developer Tools → Network → WS, что используется `wss://…/socket.io/`.

## Production checklist

- [ ] DNS направлен на сервер; наружу открыты только 80 и 443.
- [ ] `.env` не в Git; заданы `NODE_ENV=production`, точные HTTPS `PUBLIC_URL` и `CLIENT_ORIGIN`.
- [ ] Node.js слушает только `127.0.0.1:PORT`; Nginx отправляет запросы на тот же порт.
- [ ] Nginx проходит `nginx -t`, перенаправляет HTTP на HTTPS и проксирует WebSocket.
- [ ] Сертификат установлен, а `certbot renew --dry-run` проходит.
- [ ] `mini-chat` включён в автозапуск и `/healthz` работает локально и через HTTPS.
- [ ] Проверены создание комнаты, вход и WebSocket-транспорт в браузере.
- [ ] Перед релизом проходит `npm test`.
- [ ] Логи не содержат PIN, токенов, сообщений и полных payload.
