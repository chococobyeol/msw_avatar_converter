import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { buildMeaegiShareImport, extractMeaegiShareId, MEAEGI_GET_SHARE_ACTION_ID, parseMeaegiFlight } from './src/meaegiShare.js';

function meaegiSharePlugin(): Plugin {
  return {
    name: 'local-meaegi-share-api',
    configureServer(server) {
      server.middlewares.use('/api/meaegi-share', async (req, res) => {
        try {
          const requestUrl = new URL(req.url || '', 'http://localhost');
          const share = extractMeaegiShareId(requestUrl.searchParams.get('share') || '');
          if (!share) throw new Error('share query is required.');
          const upstream = await fetch('https://meaegi.com/dressing-room', {
            method: 'POST',
            headers: {
              'Next-Action': MEAEGI_GET_SHARE_ACTION_ID,
              'Content-Type': 'text/plain;charset=UTF-8',
              Accept: 'text/x-component',
            },
            body: JSON.stringify([share]),
          });
          const text = await upstream.text();
          if (!upstream.ok) throw new Error(`MeAegi returned HTTP ${upstream.status}.`);
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(buildMeaegiShareImport(share, parseMeaegiFlight(text))));
        } catch (error) {
          res.statusCode = 400;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: (error as Error).message }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), meaegiSharePlugin()],
});
