# Credit Report Worker Service

This worker service handles PDF processing for credit reports, including OCR capabilities for scanned documents.

## Features

- PDF text extraction with fallback to OCR
- OpenAI-powered credit item extraction
- Handles both positive and negative credit accounts
- Automatic deduplication
- Direct database integration

## Setup

1. Install dependencies:
```bash
npm install
```

2. Copy `.env.example` to `.env` and fill in your credentials:
```bash
cp .env.example .env
```

3. Start the service:
```bash
npm start
```

For development with auto-reload:
```bash
npm run dev
```

## Deployment Options

### Railway
1. Connect your GitHub repo to Railway
2. Set environment variables in Railway dashboard
3. Deploy

### Fly.io
1. Install Fly CLI: `curl -L https://fly.io/install.sh | sh`
2. Run `fly launch` in this directory
3. Set secrets: `fly secrets set OPENAI_API_KEY=xxx`
4. Deploy: `fly deploy`

### Heroku
1. Create a new Heroku app
2. Connect GitHub repo
3. Set config vars in Heroku dashboard
4. Deploy

### Docker
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3000
CMD ["node", "index.js"]
```

## API Endpoints

### POST /process
Process a PDF job from Supabase storage.

Request body:
```json
{
  "jobId": "uuid",
  "profileId": "uuid",
  "filePath": "path/to/file.pdf",
  "fileName": "credit_report.pdf"
}
```

### GET /health
Health check endpoint.

## Environment Variables

- `PORT` - Server port (default: 3000)
- `OPENAI_API_KEY` - OpenAI API key for text analysis
- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` - Supabase service role key for admin access
