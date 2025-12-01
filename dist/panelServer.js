import express from 'express';
import jobStore, {} from './jobStore.js';
const PANEL_PATH = '/panel';
const MAX_TEXT_LENGTH = 80;
const escapeHtml = (value) => value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
const abbreviateText = (text) => {
    if (text.length <= MAX_TEXT_LENGTH) {
        return text;
    }
    return `${text.slice(0, MAX_TEXT_LENGTH - 3)}...`;
};
const collectJobs = () => {
    const storeAccessor = jobStore;
    const rawJobs = typeof storeAccessor.getSerializedJobs === 'function'
        ? storeAccessor.getSerializedJobs()
        : typeof storeAccessor.getAllJobs === 'function'
            ? storeAccessor.getAllJobs()
            : [];
    return rawJobs.map((job) => {
        const cronValue = job.cronExpr ?? '';
        const typeValue = job.contentType ?? 'tekst';
        return {
            id: job.id ?? '—',
            chatId: job.targetChatId ?? job.ownerChatId ?? '—',
            cron: cronValue,
            type: typeValue,
            text: job.text ?? '',
        };
    });
};
const renderJobsTable = (jobs) => {
    const rows = jobs
        .map((job) => {
        const shortText = abbreviateText(job.text);
        return `
        <tr>
          <td>${escapeHtml(String(job.id))}</td>
          <td>${escapeHtml(String(job.chatId))}</td>
          <td><code>${escapeHtml(job.cron)}</code></td>
          <td>${escapeHtml(job.type)}</td>
          <td>${escapeHtml(shortText)}</td>
        </tr>
      `;
    })
        .join('');
    return `
    <table>
      <thead>
        <tr>
          <th>ID</th>
          <th>Chat</th>
          <th>CRON</th>
          <th>Typ</th>
          <th>Tekst</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;
};
const renderPage = (jobs) => {
    const content = jobs.length === 0
        ? '<p class="empty">Brak zadań.</p>'
        : renderJobsTable(jobs);
    return `<!doctype html>
<html lang="pl">
<head>
  <meta charset="utf-8" />
  <title>Panel bota Telegram</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif; margin: 24px; }
    h1 { margin-bottom: 12px; }
    .empty { color: #666; font-size: 16px; }
    table { border-collapse: collapse; width: 100%; margin-top: 10px; }
    th, td { border: 1px solid #dfe3e8; padding: 6px 10px; font-size: 14px; }
    th { background: #f4f6fb; text-align: left; }
    code { font-family: Menlo, Monaco, Consolas, monospace; }
  </style>
</head>
<body>
  <h1>Zaplanowane zadania</h1>
  ${content}
</body>
</html>`;
};
export async function startPanelServer() {
    const app = express();
    app.get(PANEL_PATH, (_req, res) => {
        const jobs = collectJobs();
        res.type('html').send(renderPage(jobs));
    });
    const port = Number(process.env.PANEL_PORT ?? 3000);
    await new Promise((resolve, reject) => {
        const server = app.listen(port, () => {
            console.log(`Panel server listening on http://localhost:${port}${PANEL_PATH}`);
            resolve();
        });
        server.on('error', reject);
    });
}
if (import.meta.url === `file://${process.argv[1]}`) {
    void startPanelServer();
}
//# sourceMappingURL=panelServer.js.map