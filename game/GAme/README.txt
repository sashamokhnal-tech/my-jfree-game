$JFREE — Variant B (extra Coin spawns 1200ms → 700ms min) + Leaderboard fix
--------------------------------------------------------------------------
Run:
  npm install
  npm start
Open:
  http://localhost:3000

Notes:
- Put your song into assets/theme.mp3 (no autoplay). Volume slider + mute in header.
- 30-day reset uses America/Los_Angeles (Portland). Override TIME_ZONE if needed.
- Leaderboard fix: after the FIRST game (even with score 0), your username appears in the table.


=== Quick Start ===
1) Install deps: npm i
2) Start: node server.js
3) Open http://localhost:3000/game/ and log in with a nickname, then start playing.
4) Scores are saved via /api/submit and shown on the 30‑day leaderboard.



=== Wallet Login (Unique ID via Solana Address) ===
- Игрок входит через кошелёк (Phantom/Backpack). Сервер выдаёт одноразовый nonce и проверяет подпись ed25519.
- Уникальность: аккаунт = адрес кошелька (Solana). Это стабильный и проверяемый идентификатор.
- API:
  * GET /api/nonce?address=<base58>
  * POST /api/wallet_login { address, signature, nonce } → { token, user_id: address }
- Хранение: leaderboard.json хранит пользователей по адресу, сессии, и очки за скользящее окно 30 дней.
- Для розыгрыша: топ‑игроков можно проверять/связываться по адресу кошелька — он и есть их уникальный ID.
