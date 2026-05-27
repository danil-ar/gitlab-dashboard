# GitLab Dashboard

Минималистичный дашборд для просмотра Merge Requests из GitLab.

## Возможности

- Список MR с фильтрацией по состоянию (opened / merged / closed), scope (all / created by me / assigned to me) и проекту
- Статус пайплайна, аппруверы, лейблы, счётчик тредов (resolved/total)
- Индикатор «я уже заапрувил» на карточке
- Фильтр «Needs my approval»
- Настройка видимых проектов через шестерёнку — все фильтры работают в рамках выбранных проектов
- Автосохранение фильтров и выбора проектов в localStorage

## Стек

| Часть | Технология |
|---|---|
| Frontend | React + Vite + Tailwind CSS |
| Backend | Python + FastAPI + httpx |
| Запуск | Docker Compose |

## Запуск

### Через Docker Compose

```bash
cp .env.example .env  # заполни GITLAB_URL и GITLAB_TOKEN
docker compose up --build
```

Открой `http://localhost:3000`.

### Локально

**Backend:**
```bash
cd backend
pip install -r requirements.txt
GITLAB_URL=https://gitlab.example.com GITLAB_TOKEN=your_token uvicorn main:app --reload
```

**Frontend:**
```bash
cd frontend
npm install
npm run dev
```

## Конфигурация

| Переменная | Описание |
|---|---|
| `GITLAB_URL` | Адрес GitLab инстанса, например `https://gitlab.com` |
| `GITLAB_TOKEN` | Personal Access Token с правами `read_api` |
